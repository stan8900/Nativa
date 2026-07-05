import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }
});

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ML_SERVER_BASE_URL = process.env.ML_SERVER_BASE_URL || 'http://127.0.0.1:8000';
let activeVoiceId = process.env.DEFAULT_VOICE_ID || 'default';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', async (_req, res) => {
  const mlHealth = await getMlHealth();

  res.json({
    ok: true,
    provider: 'self-hosted',
    mlServerBaseUrl: ML_SERVER_BASE_URL,
    mlServerReachable: mlHealth.reachable,
    mlServer: mlHealth.payload,
    voiceId: activeVoiceId
  });
});

app.post('/api/voice-clone', upload.single('sample'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Missing voice sample.' });
    }

    const startedAt = now();
    const voiceId = await createVoiceClone(req.file);
    activeVoiceId = voiceId;

    res.json({
      ok: true,
      voiceId,
      latencyMs: Math.round(now() - startedAt)
    });
  } catch (error) {
    console.error('[Nativa voice clone error]', error);
    res.status(error.status || 500).json({
      error: error.message || 'Voice clone failed.'
    });
  }
});

app.post('/api/interpret', upload.single('audio'), async (req, res) => {
  const requestStartedAt = now();
  const requestStartedWallAt = Date.now();

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Missing audio file.' });
    }

    const sourceLang = String(req.body.sourceLang || 'English');
    const targetLang = String(req.body.targetLang || 'Russian');
    const clientSpeechEndedAt = Number(req.body.speechEndedAt || Date.now());
    const history = parseHistory(req.body.history);

    const sttStartedAt = now();
    const transcript = await transcribeAudio(req.file, sourceLang);
    const sttEndedAt = now();
    const sttEndedWallAt = Date.now();

    const translateStartedAt = now();
    const translation = await translateText({
      sourceLang,
      targetLang,
      transcript,
      history
    });
    const translateEndedAt = now();

    const ttsStartedAt = now();
    const ttsResponse = await fetchTtsStream(translation);
    const firstChunk = await readFirstChunk(ttsResponse.body);
    const firstChunkEndedAt = now();
    const firstChunkEndedWallAt = Date.now();

    const metrics = {
      t1: Math.round(sttEndedWallAt - clientSpeechEndedAt),
      sttProcessingMs: Math.round(sttEndedAt - sttStartedAt),
      t2: Math.round(translateEndedAt - translateStartedAt),
      t3: Math.round(firstChunkEndedAt - ttsStartedAt),
      tTotal: Math.round(firstChunkEndedWallAt - clientSpeechEndedAt),
      serverTotalMs: Math.round(firstChunkEndedAt - requestStartedAt),
      uploadToFirstChunkMs: Math.round(firstChunkEndedWallAt - requestStartedWallAt)
    };

    console.log('[Nativa self-hosted]', {
      sourceLang,
      targetLang,
      transcript,
      translation,
      metrics
    });

    res.status(200);
    res.setHeader('Content-Type', ttsResponse.headers.get('content-type') || 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Nativa-Transcript', encodeURIComponent(transcript));
    res.setHeader('X-Nativa-Translation', encodeURIComponent(translation));
    res.setHeader('X-Nativa-Metrics', encodeURIComponent(JSON.stringify(metrics)));
    res.setHeader('Access-Control-Expose-Headers', 'X-Nativa-Transcript, X-Nativa-Translation, X-Nativa-Metrics');

    if (firstChunk?.value?.length) {
      res.write(Buffer.from(firstChunk.value));
    }

    const reader = firstChunk.reader;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }

    res.end();
  } catch (error) {
    console.error('[Nativa error]', error);
    if (!res.headersSent) {
      res.status(error.status || 500).json({
        error: error.message || 'Pipeline failed.'
      });
    } else {
      res.end();
    }
  }
});

async function getMlHealth() {
  try {
    const response = await fetch(mlUrl('/health'));
    const payload = await readJson(response);
    return {
      reachable: response.ok,
      payload
    };
  } catch (error) {
    return {
      reachable: false,
      payload: { error: error.message }
    };
  }
}

async function transcribeAudio(file, sourceLang) {
  const form = new FormData();
  const blob = new Blob([file.buffer], { type: file.mimetype || 'audio/webm' });

  form.append('audio', blob, file.originalname || 'speech.webm');
  form.append('sourceLang', sourceLang);

  const response = await fetch(mlUrl('/stt'), {
    method: 'POST',
    body: form
  });

  const payload = await readJson(response);
  if (!response.ok) {
    throw apiError('Self-hosted STT failed', response, payload);
  }

  return String(payload.text || payload.transcript || '').trim();
}

async function translateText({ sourceLang, targetLang, transcript, history }) {
  const response = await fetch(mlUrl('/translate'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sourceLang,
      targetLang,
      text: transcript,
      history: history.slice(-5)
    })
  });

  const payload = await readJson(response);
  if (!response.ok) {
    throw apiError('Self-hosted translation failed', response, payload);
  }

  return String(payload.translation || payload.text || '').trim();
}

async function fetchTtsStream(text) {
  const response = await fetch(mlUrl('/tts-stream'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg'
    },
    body: JSON.stringify({
      text,
      voiceId: activeVoiceId
    })
  });

  if (!response.ok || !response.body) {
    const payload = await response.text();
    const error = new Error(`Self-hosted TTS failed: ${payload || response.statusText}`);
    error.status = response.status;
    throw error;
  }

  return response;
}

async function createVoiceClone(file) {
  const form = new FormData();
  const blob = new Blob([file.buffer], { type: file.mimetype || 'audio/webm' });

  form.append('sample', blob, file.originalname || 'voice-sample.webm');

  const response = await fetch(mlUrl('/voice-clone'), {
    method: 'POST',
    body: form
  });

  const payload = await readJson(response);
  if (!response.ok) {
    throw apiError('Self-hosted voice clone failed', response, payload);
  }

  return String(payload.voiceId || payload.voice_id || 'default').trim();
}

function mlUrl(pathname) {
  return new URL(pathname, ML_SERVER_BASE_URL).toString();
}

async function readFirstChunk(stream) {
  const reader = stream.getReader();
  const result = await reader.read();
  return { ...result, reader };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function apiError(message, response, payload) {
  const detail = payload?.error?.message || payload?.raw || response.statusText;
  const error = new Error(`${message}: ${detail}`);
  error.status = response.status;
  return error;
}

function parseHistory(value) {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function now() {
  return performance.now();
}

app.listen(PORT, HOST, () => {
  console.log(`Nativa web app running at http://${HOST}:${PORT}`);
  console.log(`Nativa ML server expected at ${ML_SERVER_BASE_URL}`);
});
