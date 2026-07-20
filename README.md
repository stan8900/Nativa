# NATIVA

Your voice, any language.

Prototype Sprint app for measuring the end-to-end latency of:

`microphone -> VAD -> self-hosted STT -> self-hosted translation -> self-hosted TTS stream -> browser playback`

## Stack

- Frontend: HTML + vanilla JS
- Backend: Node.js + Express
- Model provider: self-hosted NATIVA ML Server
- STT: `POST /stt`
- Translation: `POST /translate`
- TTS: `POST /tts-stream`
- Voice clone: `POST /voice-clone`
- Runtime: localhost

No OpenAI. No ElevenLabs. The web app only calls the local ML server.

## Setup

```bash
npm install
cp .env.example .env
```

Fill `.env`:

```bash
ML_SERVER_BASE_URL=http://127.0.0.1:8000
DEFAULT_VOICE_ID=default
PORT=3000
HOST=127.0.0.1
GMAIL_USER=your-address@gmail.com
GMAIL_APP_PASSWORD=your-16-character-gmail-app-password
```

`GMAIL_USER` and `GMAIL_APP_PASSWORD` are only required for OTP login. Use a Gmail app password, not your normal Gmail password. In your Google account, enable 2-step verification, create an app password for Mail, then use that value as `GMAIL_APP_PASSWORD`.

## Run

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## How To Test

1. Choose the source and target language.
2. Press `Start` and speak.
3. Stop speaking. VAD ends the phrase after 500ms of silence.
4. The UI sends the phrase to the backend and starts playback when the self-hosted TTS stream arrives.
5. Repeat 10 times and compare the displayed latency numbers.
6. Use the latency table or `Export CSV` for the K-09 report.

The sprint acceptance checklist is in [TEST_PLAN.md](./TEST_PLAN.md).

Supported prototype language pairs:

- English <-> Russian
- English <-> Uzbek
- Russian <-> Uzbek is available in the UI but should be treated as secondary until tested.

## Metrics

The UI and server log:

- `t1`: speech end to self-hosted STT transcript
- `t2`: transcript to self-hosted translation
- `t3`: translation to first self-hosted TTS audio chunk
- `t_total`: speech end to first playable TTS chunk

The server also logs `sttProcessingMs` and `serverTotalMs` for debugging.

## Notes

- Browser microphone access requires `localhost` or HTTPS.
- The frontend keeps the last 5 turns in memory and sends them as translation context.
- Playback uses `MediaSource` for streamed MP3 chunks when the browser supports it, with a full-blob fallback.
- `Record 10s voice clone` sends a 10 second sample to the ML server and uses the returned `voiceId` for the next TTS calls.

## ML Server

A FastAPI scaffold lives in [`ml-server/`](./ml-server). It starts in mock mode, then each service can be replaced with real local models:

- STT: `faster-whisper` or `whisper.cpp`
- Translation: `NLLB-200`, `M2M100`, or local LLM
- TTS: `XTTS`, `StyleTTS2`, `Coqui`, or `Piper`
- Voice clone: speaker embedding with `SpeechBrain` or `resemblyzer`

Run it:

```bash
cd ml-server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

## Custom Model Contract

The NATIVA backend expects your ML server at `ML_SERVER_BASE_URL` to implement these endpoints.

### `POST /stt`

Multipart form:

- `audio`: recorded browser audio, usually WebM/Opus
- `sourceLang`: `English`, `Russian`, or `Uzbek`

Response:

```json
{ "text": "recognized speech" }
```

### `POST /translate`

JSON body:

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

JSON body:

```json
{
  "text": "Привет",
  "voiceId": "optional-active-voice-id"
}
```

Response: streamed audio, preferably `audio/mpeg`.

### `POST /voice-clone`

Multipart form:

- `sample`: 10 second voice sample

Response:

```json
{ "voiceId": "speaker-123" }
```
