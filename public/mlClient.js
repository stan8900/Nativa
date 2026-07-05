const ML_SERVER = window.NATIVA_ML_SERVER_URL ?? 'http://localhost:8000';

export async function health() {
  const started = performance.now();
  const response = await fetch(`${ML_SERVER}/health`);
  const payload = await response.json();
  return {
    ...payload,
    latency_ms: Math.round(performance.now() - started)
  };
}

export async function stt(audio, sourceLang = 'Russian') {
  const started = performance.now();
  const form = new FormData();
  form.append('audio', audio, audio.type.includes('mp4') ? 'speech.mp4' : 'speech.webm');
  form.append('sourceLang', sourceLang);

  const response = await fetch(`${ML_SERVER}/stt`, {
    method: 'POST',
    body: form
  });
  const payload = await readJson(response);
  assertOk(response, payload, '/stt');

  return {
    text: String(payload.text || payload.transcript || ''),
    latency_ms: Math.round(performance.now() - started)
  };
}

export async function translate(text, src, tgt, history = []) {
  const started = performance.now();
  const response = await fetch(`${ML_SERVER}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceLang: src,
      targetLang: tgt,
      text,
      history
    })
  });
  const payload = await readJson(response);
  assertOk(response, payload, '/translate');

  return {
    text: String(payload.translation || payload.text || ''),
    latency_ms: Math.round(performance.now() - started)
  };
}

export async function ttsStream(text, voiceId = 'default') {
  const response = await fetch(`${ML_SERVER}/tts-stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg, audio/wav'
    },
    body: JSON.stringify({ text, voiceId })
  });

  if (!response.ok || !response.body) {
    const payload = await response.text();
    throw new Error(`/tts-stream failed: ${payload || response.statusText}`);
  }

  return response.body;
}

export async function voiceClone(audio) {
  const form = new FormData();
  form.append('sample', audio, audio.type.includes('mp4') ? 'voice-sample.mp4' : 'voice-sample.webm');

  const response = await fetch(`${ML_SERVER}/voice-clone`, {
    method: 'POST',
    body: form
  });
  const payload = await readJson(response);
  assertOk(response, payload, '/voice-clone');

  return {
    voice_id: String(payload.voiceId || payload.voice_id || 'default')
  };
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

function assertOk(response, payload, endpoint) {
  if (response.ok) return;
  throw new Error(`${endpoint} failed: ${payload.error || payload.raw || response.statusText}`);
}
