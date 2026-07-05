const elements = {
  configStatus: document.querySelector('#configStatus'),
  sourceLang: document.querySelector('#sourceLang'),
  targetLang: document.querySelector('#targetLang'),
  swapButton: document.querySelector('#swapButton'),
  recordButton: document.querySelector('#recordButton'),
  recordLabel: document.querySelector('#recordLabel'),
  cloneButton: document.querySelector('#cloneButton'),
  cloneStatus: document.querySelector('#cloneStatus'),
  levelBar: document.querySelector('#levelBar'),
  vadState: document.querySelector('#vadState'),
  transcript: document.querySelector('#transcript'),
  translation: document.querySelector('#translation'),
  metricT1: document.querySelector('#metricT1'),
  metricT2: document.querySelector('#metricT2'),
  metricT3: document.querySelector('#metricT3'),
  metricTotal: document.querySelector('#metricTotal'),
  historyList: document.querySelector('#historyList'),
  runTableBody: document.querySelector('#runTableBody'),
  clearHistory: document.querySelector('#clearHistory'),
  exportCsv: document.querySelector('#exportCsv')
};

const state = {
  stream: null,
  audioContext: null,
  analyser: null,
  mediaRecorder: null,
  chunks: [],
  rafId: null,
  recording: false,
  speechDetected: false,
  silenceStartedAt: null,
  history: [],
  runs: [],
  cloning: false
};

const SILENCE_MS = 500;
const MIN_RECORDING_MS = 450;
const SPEECH_THRESHOLD = 0.035;

checkHealth();

elements.recordButton.addEventListener('click', () => {
  if (state.recording) {
    finishPhrase();
  } else {
    startListening();
  }
});

elements.swapButton.addEventListener('click', () => {
  const source = elements.sourceLang.value;
  elements.sourceLang.value = elements.targetLang.value;
  elements.targetLang.value = source;
});

elements.clearHistory.addEventListener('click', () => {
  state.history = [];
  state.runs = [];
  renderHistory();
  renderRunTable();
});

elements.exportCsv.addEventListener('click', exportCsv);
elements.cloneButton.addEventListener('click', recordVoiceClone);

async function checkHealth() {
  try {
    const response = await fetch('/api/health');
    const health = await response.json();
    const ready = Boolean(health.mlServerReachable);
    elements.configStatus.textContent = ready
      ? 'Self-hosted ML server ready'
      : `ML server unreachable: ${health.mlServerBaseUrl}`;
    elements.cloneStatus.textContent = ready
      ? `ML stack: ${formatMlStack(health.mlServer?.stack)}`
      : `Active voice: ${health.voiceId}`;
    elements.configStatus.classList.toggle('ok', ready);
    elements.configStatus.classList.toggle('bad', !ready);
  } catch {
    elements.configStatus.textContent = 'Server not reachable';
    elements.configStatus.classList.add('bad');
  }
}

async function recordVoiceClone() {
  if (state.recording || state.cloning) return;

  state.cloning = true;
  elements.cloneButton.disabled = true;
  elements.cloneStatus.textContent = 'Recording voice sample: 10s.';

  let stream;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];

    recorder.addEventListener('dataavailable', event => {
      if (event.data.size > 0) chunks.push(event.data);
    });

    const stopped = new Promise(resolve => {
      recorder.addEventListener('stop', resolve, { once: true });
    });

    recorder.start(100);

    for (let remaining = 10; remaining > 0; remaining -= 1) {
      elements.cloneStatus.textContent = `Recording voice sample: ${remaining}s.`;
      await sleep(1000);
    }

    recorder.stop();
    await stopped;

    const sample = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    elements.cloneStatus.textContent = 'Uploading sample to ML server.';

    const form = new FormData();
    form.append('sample', sample, `voice-sample.${sample.type.includes('mp4') ? 'mp4' : 'webm'}`);

    const response = await fetch('/api/voice-clone', {
      method: 'POST',
      body: form
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || response.statusText);
    }

    elements.cloneStatus.textContent = `Active cloned voice: ${payload.voiceId}`;
    await checkHealth();
  } catch (error) {
    console.error(error);
    elements.cloneStatus.textContent = error.message;
  } finally {
    stream?.getTracks().forEach(track => track.stop());
    elements.cloneButton.disabled = false;
    state.cloning = false;
  }
}

async function startListening() {
  resetMetrics();
  elements.transcript.textContent = 'Listening.';
  elements.translation.textContent = 'Phrase ends after 500ms of silence.';

  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

  state.audioContext = new AudioContext();
  const source = state.audioContext.createMediaStreamSource(state.stream);
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 2048;
  source.connect(state.analyser);

  const mimeType = pickMimeType();
  state.mediaRecorder = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
  state.chunks = [];
  state.recordingStartedAt = performance.now();
  state.speechDetected = false;
  state.silenceStartedAt = null;
  state.recording = true;

  state.mediaRecorder.addEventListener('dataavailable', event => {
    if (event.data.size > 0) state.chunks.push(event.data);
  });

  state.mediaRecorder.addEventListener('stop', handleRecordingStopped, { once: true });
  state.mediaRecorder.start(100);

  setRecordingUi(true);
  monitorVad();
}

function monitorVad() {
  const data = new Uint8Array(state.analyser.fftSize);

  const tick = () => {
    if (!state.recording) return;

    state.analyser.getByteTimeDomainData(data);
    const level = rms(data);
    elements.levelBar.style.width = `${Math.min(level * 420, 100)}%`;

    const elapsed = performance.now() - state.recordingStartedAt;
    if (level > SPEECH_THRESHOLD) {
      state.speechDetected = true;
      state.silenceStartedAt = null;
      elements.vadState.textContent = 'Speech';
    } else if (state.speechDetected) {
      if (!state.silenceStartedAt) state.silenceStartedAt = performance.now();
      const silentFor = performance.now() - state.silenceStartedAt;
      elements.vadState.textContent = `Silence ${Math.round(silentFor)}ms`;

      if (silentFor >= SILENCE_MS && elapsed >= MIN_RECORDING_MS) {
        finishPhrase();
        return;
      }
    } else {
      elements.vadState.textContent = 'Waiting';
    }

    state.rafId = requestAnimationFrame(tick);
  };

  tick();
}

function finishPhrase() {
  if (!state.recording) return;

  state.speechEndedAt = Date.now();
  state.recording = false;
  cancelAnimationFrame(state.rafId);
  elements.vadState.textContent = 'Processing';
  elements.levelBar.style.width = '0%';
  setRecordingUi(false);

  if (state.mediaRecorder?.state !== 'inactive') {
    state.mediaRecorder.stop();
  }

  stopStream();
}

async function handleRecordingStopped() {
  const type = state.mediaRecorder.mimeType || 'audio/webm';
  const audioBlob = new Blob(state.chunks, { type });

  if (!state.speechDetected || audioBlob.size < 900) {
    elements.transcript.textContent = 'No speech detected.';
    elements.translation.textContent = 'Try again closer to the microphone.';
    elements.vadState.textContent = 'Mic idle';
    return;
  }

  await runPipeline(audioBlob);
}

async function runPipeline(audioBlob) {
  const form = new FormData();
  form.append('audio', audioBlob, `speech.${audioBlob.type.includes('mp4') ? 'mp4' : 'webm'}`);
  form.append('sourceLang', elements.sourceLang.value);
  form.append('targetLang', elements.targetLang.value);
  form.append('speechEndedAt', String(state.speechEndedAt));
  form.append('history', JSON.stringify(state.history.slice(-5)));

  elements.transcript.textContent = 'Whisper is transcribing.';
  elements.translation.textContent = 'Waiting for translation.';

  try {
    const response = await fetch('/api/interpret', {
      method: 'POST',
      body: form
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || response.statusText);
    }

    const transcript = decodeHeader(response.headers.get('X-Nativa-Transcript'));
    const translation = decodeHeader(response.headers.get('X-Nativa-Translation'));
    const metrics = JSON.parse(decodeHeader(response.headers.get('X-Nativa-Metrics')) || '{}');

    elements.transcript.textContent = transcript || 'No transcript returned.';
    elements.translation.textContent = translation || 'No translation returned.';
    renderMetrics(metrics);
    console.log('[Nativa metrics]', metrics);

    await playStream(response);

    state.history.push({
      sourceLang: elements.sourceLang.value,
      targetLang: elements.targetLang.value,
      transcript,
      translation,
      metrics
    });
    state.runs.push({
      id: state.runs.length + 1,
      sourceLang: elements.sourceLang.value,
      targetLang: elements.targetLang.value,
      transcript,
      translation,
      metrics
    });
    state.history = state.history.slice(-5);
    renderHistory();
    renderRunTable();
    elements.vadState.textContent = 'Mic idle';
  } catch (error) {
    console.error(error);
    elements.translation.textContent = error.message;
    elements.vadState.textContent = 'Error';
  }
}

async function playStream(response) {
  if (!response.body || !window.MediaSource || !MediaSource.isTypeSupported('audio/mpeg')) {
    const audioBlob = await response.blob();
    const url = URL.createObjectURL(audioBlob);
    const audio = new Audio(url);
    audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
    await audio.play();
    return;
  }

  const mediaSource = new MediaSource();
  const audio = new Audio(URL.createObjectURL(mediaSource));
  const reader = response.body.getReader();
  const queue = [];
  let sourceBuffer;
  let streamDone = false;

  mediaSource.addEventListener('sourceopen', async () => {
    sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
    sourceBuffer.mode = 'sequence';
    sourceBuffer.addEventListener('updateend', appendNextChunk);

    audio.play().catch(error => {
      console.warn('Autoplay blocked until user gesture.', error);
    });

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        streamDone = true;
        appendNextChunk();
        break;
      }

      queue.push(value);
      appendNextChunk();
    }
  }, { once: true });

  audio.addEventListener('ended', () => URL.revokeObjectURL(audio.src), { once: true });

  function appendNextChunk() {
    if (!sourceBuffer || sourceBuffer.updating || queue.length === 0) {
      if (streamDone && sourceBuffer && !sourceBuffer.updating && mediaSource.readyState === 'open') {
        mediaSource.endOfStream();
      }
      return;
    }

    sourceBuffer.appendBuffer(queue.shift());
  }
}

function renderMetrics(metrics) {
  elements.metricT1.textContent = formatMs(metrics.t1);
  elements.metricT2.textContent = formatMs(metrics.t2);
  elements.metricT3.textContent = formatMs(metrics.t3);
  elements.metricTotal.textContent = formatMs(metrics.tTotal);
}

function renderHistory() {
  elements.historyList.innerHTML = '';

  for (const turn of [...state.history].reverse()) {
    const li = document.createElement('li');
    li.innerHTML = `<b>${escapeHtml(turn.transcript)}</b><br>${escapeHtml(turn.translation)}<br>Total ${formatMs(turn.metrics?.tTotal)}`;
    elements.historyList.append(li);
  }
}

function renderRunTable() {
  elements.runTableBody.innerHTML = '';

  if (state.runs.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="9">No runs yet.</td>';
    elements.runTableBody.append(row);
    return;
  }

  for (const run of state.runs) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${run.id}</td>
      <td>${escapeHtml(run.sourceLang)}</td>
      <td>${escapeHtml(run.targetLang)}</td>
      <td>${escapeHtml(run.transcript)}</td>
      <td>${escapeHtml(run.translation)}</td>
      <td>${formatMs(run.metrics?.t1)}</td>
      <td>${formatMs(run.metrics?.t2)}</td>
      <td>${formatMs(run.metrics?.t3)}</td>
      <td>${formatMs(run.metrics?.tTotal)}</td>
    `;
    elements.runTableBody.append(row);
  }
}

function exportCsv() {
  const rows = [
    ['run', 'source_lang', 'target_lang', 'transcript', 'translation', 't1_ms', 't2_ms', 't3_ms', 'total_ms']
  ];

  for (const run of state.runs) {
    rows.push([
      run.id,
      run.sourceLang,
      run.targetLang,
      run.transcript,
      run.translation,
      run.metrics?.t1 ?? '',
      run.metrics?.t2 ?? '',
      run.metrics?.t3 ?? '',
      run.metrics?.tTotal ?? ''
    ]);
  }

  const csv = rows
    .map(row => row.map(csvCell).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = `nativa-latency-${new Date().toISOString()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function resetMetrics() {
  elements.metricT1.textContent = '-';
  elements.metricT2.textContent = '-';
  elements.metricT3.textContent = '-';
  elements.metricTotal.textContent = '-';
}

function setRecordingUi(recording) {
  elements.recordButton.classList.toggle('recording', recording);
  elements.recordLabel.textContent = recording ? 'Stop' : 'Start';
}

function stopStream() {
  state.stream?.getTracks().forEach(track => track.stop());
  state.audioContext?.close();
  state.stream = null;
  state.audioContext = null;
}

function pickMimeType() {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4'
  ];

  return types.find(type => MediaRecorder.isTypeSupported(type));
}

function rms(data) {
  let sum = 0;
  for (const value of data) {
    const centered = (value - 128) / 128;
    sum += centered * centered;
  }

  return Math.sqrt(sum / data.length);
}

function decodeHeader(value) {
  if (!value) return '';
  return decodeURIComponent(value);
}

function formatMs(value) {
  if (!Number.isFinite(Number(value))) return '-';
  return `${Math.max(0, Math.round(Number(value)))}ms`;
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatMlStack(stack) {
  if (!stack) return 'unknown';
  return [stack.stt, stack.translation, stack.tts, stack.voice].filter(Boolean).join(' / ');
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
