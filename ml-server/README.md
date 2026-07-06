# NATIVA ML Server

FastAPI backend for local STT, translation, voice cloning, and XTTS v2 speech synthesis.

## Run

```bash
cd ml-server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Install `ffmpeg` for reliable browser audio/WebM conversion:

```bash
brew install ffmpeg
```

First startup downloads model weights into `ml-server/models/`. XTTS v2 is roughly 2GB; progress is printed by Coqui TTS and server logs.

## Configuration

```bash
NATIVA_MODE=real
NATIVA_WHISPER_MODEL_SIZE=base
NATIVA_WHISPER_COMPUTE_TYPE=int8
NATIVA_VOICES_DIR=./voices
NATIVA_MODELS_DIR=./models
```

Device is selected automatically: `cuda` when `torch.cuda.is_available()` is true, otherwise `cpu`.

## Endpoints

### `POST /voice-clone`

Multipart form:

- `audio`: WAV/WebM voice sample, at least 6 seconds

Compatibility alias: `sample`.

Response:

```json
{ "voice_id": "uuid4" }
```

The normalized speaker reference is saved at `voices/{voice_id}.wav`.

### `POST /tts-stream`

```json
{
  "text": "Привет",
  "voice_id": "uuid4",
  "language": "ru"
}
```

Compatibility alias: `voiceId`.

Response: chunked `audio/wav` stream.

### `POST /stt`

Multipart form:

- `audio`: WAV/WebM speech audio
- `src_lang`: `ru` or `en`

Compatibility alias: `sourceLang`.

Response:

```json
{ "text": "recognized speech", "language": "ru", "latency_ms": 1234 }
```

### `POST /translate`

```json
{
  "text": "Привет",
  "src_lang": "ru",
  "tgt_lang": "en"
}
```

Compatibility aliases: `sourceLang`, `targetLang`.

Response:

```json
{ "text": "Hello", "translation": "Hello", "latency_ms": 123 }
```

Supported pairs are `ru-en` and `en-ru` via Helsinki-NLP OPUS-MT.

### `POST /pipeline`

Multipart form:

- `audio`: WAV/WebM speech audio
- `voice_id`: saved voice sample id
- `src_lang`: source language
- `tgt_lang`: target language

Response: chunked `audio/wav` stream with headers:

- `X-Transcript`
- `X-Translation`
- `X-Latency-STT`
- `X-Latency-Translate`
- `X-Latency-TTS`

Transcript and translation headers are URL-encoded so non-ASCII text is safe in HTTP headers.
