# NATIVA ML Server

Self-hosted ML backend for the NATIVA prototype. No OpenAI and no ElevenLabs.

The web app calls this server through:

- `POST /stt`
- `POST /translate`
- `POST /tts-stream`
- `POST /voice-clone`

Default mode is `mock`, so the full web pipeline can run before real models are installed.

## Run

```bash
cd ml-server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Then run the web app from the repo root:

```bash
npm run dev
```

## Configuration

```bash
NATIVA_ML_MODE=mock
NATIVA_STT_ENGINE=faster-whisper
NATIVA_TRANSLATION_ENGINE=nllb-200
NATIVA_TTS_ENGINE=piper
NATIVA_VOICE_ENGINE=speechbrain
```

Only `mock` is implemented in this scaffold. Real adapters should be added behind the same service interfaces.

## Model Roadmap

Recommended implementation order:

1. STT: `faster-whisper` first, `whisper.cpp` for CPU/edge experiments.
2. Translation: `NLLB-200` or `M2M100` for EN/RU/UZ baseline, local LLM later for conversational nuance.
3. TTS: `Piper` for fast baseline, `XTTS` or `StyleTTS2` for voice quality.
4. Voice clone: speaker embedding with `SpeechBrain` or `resemblyzer`, then connect embedding to the chosen TTS.
5. Streaming: return the first audio chunk as early as possible; do not wait for full synthesis.

## Endpoint Contract

### `POST /stt`

Multipart form:

- `audio`: WebM/Opus from browser
- `sourceLang`: `English`, `Russian`, or `Uzbek`

Response:

```json
{ "text": "recognized speech" }
```

### `POST /translate`

```json
{
  "sourceLang": "English",
  "targetLang": "Russian",
  "text": "Hello",
  "history": []
}
```

Response:

```json
{ "translation": "Привет" }
```

### `POST /tts-stream`

```json
{
  "text": "Привет",
  "voiceId": "default"
}
```

Response: chunked audio. The mock server returns `audio/wav`.

### `POST /voice-clone`

Multipart form:

- `sample`: 10 second voice sample

Response:

```json
{ "voiceId": "speaker-..." }
```
