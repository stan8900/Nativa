import { health, stt, translate, ttsStream, voiceClone } from './mlClient.js';
import { runMockPipeline } from './useMockPipeline.js';

const elements = {
  voiceModeButton: document.querySelector('#voiceModeButton'),
  debugModeButton: document.querySelector('#debugModeButton'),
  voiceView: document.querySelector('#voiceView'),
  debugView: document.querySelector('#debugView'),
  connectionBadge: document.querySelector('#connectionBadge'),
  languagePair: document.querySelector('#languagePair'),
  voiceVisualizer: document.querySelector('#voiceVisualizer'),
  pipelineState: document.querySelector('#pipelineState'),
  activeSpeaker: document.querySelector('#activeSpeaker'),
  recordButton: document.querySelector('#recordButton'),
  recordLabel: document.querySelector('#recordLabel'),
  voiceCloneButton: document.querySelector('#voiceCloneButton'),
  ttsTextInput: document.querySelector('#ttsTextInput'),
  speakTextButton: document.querySelector('#speakTextButton'),
  vadState: document.querySelector('#vadState'),
  sourceLang: document.querySelector('#sourceLang'),
  targetLang: document.querySelector('#targetLang'),
  swapButton: document.querySelector('#swapButton'),
  historyList: document.querySelector('#historyList'),
  clearHistory: document.querySelector('#clearHistory'),
  metricStt: document.querySelector('#metricStt'),
  metricTranslate: document.querySelector('#metricTranslate'),
  metricTts: document.querySelector('#metricTts'),
  metricTotal: document.querySelector('#metricTotal'),
  latencyRows: document.querySelector('#latencyRows'),
  latencyStats: document.querySelector('#latencyStats'),
  debugConsole: document.querySelector('#debugConsole'),
  clearLog: document.querySelector('#clearLog'),
  runKTests: document.querySelector('#runKTests'),
  exportCsv: document.querySelector('#exportCsv')
};

const state = {
  mode: 'voice',
  status: 'idle',
  mlConnected: false,
  stream: null,
  audioContext: null,
  analyser: null,
  mediaRecorder: null,
  chunks: [],
  rafId: null,
  visualizerRafId: null,
  recording: false,
  speechDetected: false,
  silenceStartedAt: null,
  history: [],
  runs: [],
  logs: [],
  visualizerMode: 'idle',
  voiceId: 'default'
};

const SILENCE_MS = 500;
const MIN_RECORDING_MS = 450;
const SPEECH_THRESHOLD = 0.003;
const BAR_COUNT = 32;

const K_TESTS = [
  { id: 'K-01', src: 'English', tgt: 'Russian', transcript: 'Hello, my name is John and I want to schedule a meeting' },
  { id: 'K-02', src: 'Russian', tgt: 'English', transcript: 'Привет, я хочу заказать столик на двоих на пятницу' },
  { id: 'K-03', src: 'English', tgt: 'Russian', transcript: 'Yes' },
  { id: 'K-04', src: 'English', tgt: 'Russian', transcript: 'I want to schedule a meeting tomorrow afternoon with the product and machine learning teams to review latency metrics and decide what needs to be optimized next.' },
  { id: 'K-05', src: 'English', tgt: 'Russian', transcript: "It's been stressful lately" },
  { id: 'K-06', src: 'Russian', tgt: 'English', transcript: 'Добрый день, можно проверить перевод на фоне шума' },
  { id: 'K-07', src: 'English', tgt: 'Russian', transcript: 'I want to book a flight' },
  { id: 'K-08', src: 'Russian', tgt: 'English', transcript: 'Тест стабильности номер восемь' },
  { id: 'K-09', src: 'English', tgt: 'Russian', transcript: 'Latency measurement test' },
  { id: 'K-10', src: 'Russian', tgt: 'English', transcript: 'Тест клонирования голоса' }
];

init();

function init() {
  createVisualizerBars();
  bindEvents();
  updateLanguagePair();
  setStatus('idle');
  startAmbientVisualizer();
  checkConnection();
  renderHistory();
  renderLatencyTable();
}

function bindEvents() {
  elements.voiceModeButton.addEventListener('click', () => setMode('voice'));
  elements.debugModeButton.addEventListener('click', () => setMode('debug'));
  elements.recordButton.addEventListener('click', () => {
    if (state.recording) finishPhrase();
    else startListening();
  });
  elements.voiceCloneButton.addEventListener('click', recordVoiceClone);
  elements.speakTextButton.addEventListener('click', speakTypedText);
  elements.swapButton.addEventListener('click', () => {
    const source = elements.sourceLang.value;
    elements.sourceLang.value = elements.targetLang.value;
    elements.targetLang.value = source;
    updateLanguagePair();
  });
  elements.sourceLang.addEventListener('change', updateLanguagePair);
  elements.targetLang.addEventListener('change', updateLanguagePair);
  elements.clearHistory.addEventListener('click', () => {
    state.history = [];
    renderHistory();
  });
  elements.clearLog.addEventListener('click', () => {
    state.logs = [];
    renderLogs();
  });
  elements.runKTests.addEventListener('click', runKTests);
  elements.exportCsv.addEventListener('click', exportCsv);
}

async function speakTypedText() {
  const text = elements.ttsTextInput.value.trim();
  if (!text) {
    addLog('/tts-stream', 0, 'empty text');
    return;
  }

  elements.speakTextButton.disabled = true;
  elements.speakTextButton.textContent = 'Speaking...';
  state.visualizerMode = 'bot';
  setStatus('processing');

  try {
    const started = performance.now();
    const stream = await ttsStream(text, state.voiceId);
    const ttsLatency = Math.round(performance.now() - started);
    addLog('/tts-stream', ttsLatency, `voice_id: ${state.voiceId}`);
    await drainAudioStream(stream);
  } catch (error) {
    addLog('/tts-stream', 0, error.message);
  } finally {
    elements.speakTextButton.disabled = false;
    elements.speakTextButton.textContent = 'Speak';
    state.visualizerMode = 'idle';
    elements.activeSpeaker.textContent = 'idle';
    setStatus('idle');
  }
}

async function recordVoiceClone() {
  const originalLabel = elements.voiceCloneButton.textContent;
  elements.voiceCloneButton.textContent = '⏺ Recording 10s...';
  elements.voiceCloneButton.classList.add('recording');
  elements.voiceCloneButton.disabled = true;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks = [];

    recorder.addEventListener('dataavailable', event => {
      if (event.data.size > 0) chunks.push(event.data);
    });

    recorder.addEventListener('stop', async () => {
      stream.getTracks().forEach(track => track.stop());
      try {
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const formData = new FormData();
        formData.append('audio', blob, 'voice.webm');
        const result = await voiceClone(formData);
        state.voiceId = result.voice_id || result.voiceId || 'default';
        elements.voiceCloneButton.textContent = '✓ Voice cloned';
        addLog('/voice-clone', 0, `voice_id: ${state.voiceId}`);
      } catch (error) {
        elements.voiceCloneButton.textContent = 'Clone failed';
        addLog('/voice-clone', 0, error.message);
      } finally {
        elements.voiceCloneButton.classList.remove('recording');
        elements.voiceCloneButton.disabled = false;
      }
    });

    recorder.start();
    setTimeout(() => recorder.stop(), 10000);
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    elements.voiceCloneButton.textContent = originalLabel;
    elements.voiceCloneButton.classList.remove('recording');
    elements.voiceCloneButton.disabled = false;
    addLog('/voice-clone', 0, error.message);
  }
}

async function checkConnection() {
  try {
    const result = await health();
    state.mlConnected = Boolean(result.ok);
    setConnection('connected', `Connected ${result.latency_ms}ms`);
    addLog('/health', result.latency_ms, 200);
  } catch (error) {
    state.mlConnected = false;
    setConnection('warning', 'Mock mode');
    addLog('/health', 0, 'mock');
  }
}

function setMode(mode) {
  state.mode = mode;
  elements.voiceModeButton.classList.toggle('active', mode === 'voice');
  elements.debugModeButton.classList.toggle('active', mode === 'debug');
  elements.voiceView.classList.toggle('active', mode === 'voice');
  elements.debugView.classList.toggle('active', mode === 'debug');
}

async function startListening() {
  try {
    setStatus('recording');
    state.visualizerMode = 'mic';
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
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

    monitorVad();
  } catch (error) {
    setStatus('error');
    setConnection('error', 'Mic denied');
    addLog('mic', 0, error.message);
  }
}

function monitorVad() {
  const data = new Uint8Array(state.analyser.fftSize);

  const tick = () => {
    if (!state.recording) return;

    state.analyser.getByteTimeDomainData(data);
    const level = rms(data);
    updateVisualizerFromLevel(level);

    const elapsed = performance.now() - state.recordingStartedAt;
    if (level > SPEECH_THRESHOLD) {
      state.speechDetected = true;
      state.silenceStartedAt = null;
      elements.vadState.textContent = 'speech';
    } else if (state.speechDetected) {
      if (!state.silenceStartedAt) state.silenceStartedAt = performance.now();
      const silentFor = performance.now() - state.silenceStartedAt;
      elements.vadState.textContent = `silent ${Math.round(silentFor)}ms`;

      if (silentFor >= SILENCE_MS && elapsed >= MIN_RECORDING_MS) {
        finishPhrase();
        return;
      }
    } else {
      elements.vadState.textContent = 'silent';
    }

    state.rafId = requestAnimationFrame(tick);
  };

  tick();
}

function finishPhrase() {
  if (!state.recording) return;

  state.recording = false;
  cancelAnimationFrame(state.rafId);
  elements.vadState.textContent = 'processing';
  setStatus('processing');

  if (state.mediaRecorder?.state !== 'inactive') {
    state.mediaRecorder.stop();
  }

  stopStream();
}

async function handleRecordingStopped() {
  const type = state.mediaRecorder.mimeType || 'audio/webm';
  const audioBlob = new Blob(state.chunks, { type });

  if (!state.speechDetected || audioBlob.size < 900) {
    setStatus('idle');
    elements.vadState.textContent = 'silent';
    addLog('vad', 0, 'no speech');
    return;
  }

  await runPipeline(audioBlob);
}

async function runPipeline(audioBlob) {
  state.visualizerMode = 'bot';
  setStatus('processing');
  const src = elements.sourceLang.value;
  const tgt = elements.targetLang.value;

  try {
    if (!state.mlConnected) throw new Error('ML server unavailable');

    const sttResult = await stt(audioBlob, src);
    addLog('/stt', sttResult.latency_ms, 200);

    const translateResult = await translate(sttResult.text, src, tgt, state.history.slice(-5));
    addLog('/translate', translateResult.latency_ms, 200);

    const ttsStarted = performance.now();
    const stream = await ttsStream(translateResult.text, state.voiceId);
    const ttsLatency = Math.round(performance.now() - ttsStarted);
    addLog('/tts-stream', ttsLatency, 200);

    await drainAudioStream(stream);

    commitRun({
      caseId: `Live-${state.runs.length + 1}`,
      sourceLang: src,
      targetLang: tgt,
      transcript: sttResult.text,
      translation: translateResult.text,
      latency: {
        stt: sttResult.latency_ms,
        translate: translateResult.latency_ms,
        tts: ttsLatency,
        total: sttResult.latency_ms + translateResult.latency_ms + ttsLatency
      }
    });
  } catch (error) {
    addLog('fallback', 0, error.message);
    const result = await runMockPipeline(audioBlob, {
      sourceLang: src,
      targetLang: tgt
    });
    for (const log of result.logs) addLog(log.endpoint, log.latency, log.status, log.timestamp);
    commitRun({
      caseId: `Mock-${state.runs.length + 1}`,
      sourceLang: src,
      targetLang: tgt,
      transcript: result.transcript,
      translation: result.translation,
      latency: result.latency
    });
  } finally {
    setStatus('done');
    state.visualizerMode = 'idle';
    elements.activeSpeaker.textContent = 'idle';
    elements.vadState.textContent = 'silent';
    window.setTimeout(() => setStatus('idle'), 900);
  }
}

async function runKTests() {
  setMode('debug');
  elements.runKTests.disabled = true;
  state.visualizerMode = 'bot';
  setStatus('processing');

  try {
    for (const test of K_TESTS) {
      const audio = new Blob(['mock'], { type: 'audio/webm' });
      const result = await runMockPipeline(audio, {
        caseId: test.id,
        transcript: test.transcript,
        sourceLang: test.src,
        targetLang: test.tgt
      });

      for (const log of result.logs) addLog(log.endpoint, log.latency, log.status, log.timestamp);
      commitRun({
        caseId: test.id,
        sourceLang: test.src,
        targetLang: test.tgt,
        transcript: result.transcript,
        translation: result.translation,
        latency: result.latency
      });
    }
  } finally {
    elements.runKTests.disabled = false;
    state.visualizerMode = 'idle';
    elements.activeSpeaker.textContent = 'idle';
    setStatus('done');
    window.setTimeout(() => setStatus('idle'), 900);
  }
}

function commitRun(run) {
  const normalized = {
    id: state.runs.length + 1,
    status: run.latency.total < 2000 ? '✓' : '✗',
    ...run
  };

  state.runs.push(normalized);
  state.history.push(normalized);
  state.history = state.history.slice(-5);
  renderMetrics(run.latency);
  renderHistory();
  renderLatencyTable();
}

function createVisualizerBars() {
  elements.voiceVisualizer.innerHTML = '';
  for (let index = 0; index < BAR_COUNT; index += 1) {
    const bar = document.createElement('span');
    bar.style.height = '14px';
    elements.voiceVisualizer.append(bar);
  }
}

function startAmbientVisualizer() {
  const bars = [...elements.voiceVisualizer.children];
  const tick = () => {
    if (state.visualizerMode === 'idle') {
      const now = performance.now() / 440;
      bars.forEach((bar, index) => {
        const wave = Math.sin(now + index * 0.55);
        bar.style.height = `${18 + Math.abs(wave) * 34}px`;
        bar.style.opacity = `${0.45 + Math.abs(wave) * 0.4}`;
      });
    } else if (state.visualizerMode === 'bot') {
      const now = performance.now() / 150;
      bars.forEach((bar, index) => {
        const wave = Math.sin(now + index * 0.8);
        bar.style.height = `${26 + Math.abs(wave) * 70}px`;
        bar.style.opacity = '0.95';
      });
    }
    state.visualizerRafId = requestAnimationFrame(tick);
  };
  tick();
}

function updateVisualizerFromLevel(level) {
  const bars = [...elements.voiceVisualizer.children];
  bars.forEach((bar, index) => {
    const offset = 0.45 + Math.abs(Math.sin(index * 0.7)) * 0.8;
    const height = 10 + Math.min(110, level * 900 * offset);
    bar.style.height = `${height}px`;
    bar.style.opacity = `${0.45 + Math.min(0.5, level * 10)}`;
  });
}

function setStatus(status) {
  state.status = status;
  elements.pipelineState.textContent = status;
  elements.activeSpeaker.textContent = state.visualizerMode === 'bot' ? 'bot' : state.visualizerMode;
  elements.recordButton.classList.toggle('recording', status === 'recording');
  elements.recordLabel.textContent = status === 'recording' ? 'STOP' : 'START';
}

function setConnection(type, label) {
  elements.connectionBadge.className = `status-badge ${type}`;
  elements.connectionBadge.querySelector('b').textContent = label;
}

function updateLanguagePair() {
  elements.languagePair.textContent = `${langCode(elements.sourceLang.value)} -> ${langCode(elements.targetLang.value)}`;
}

function renderMetrics(latency) {
  elements.metricStt.textContent = formatMs(latency.stt);
  elements.metricTranslate.textContent = formatMs(latency.translate);
  elements.metricTts.textContent = formatMs(latency.tts);
  elements.metricTotal.textContent = formatMs(latency.total);
}

function renderHistory() {
  elements.historyList.innerHTML = '';
  if (state.history.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No replicas yet.';
    elements.historyList.append(empty);
    return;
  }

  for (const turn of [...state.history].reverse()) {
    const li = document.createElement('li');
    li.innerHTML = `<span>&gt; "${escapeHtml(turn.transcript)}"</span><strong>→</strong><span>"${escapeHtml(turn.translation)}"</span>`;
    elements.historyList.append(li);
  }
}

function renderLatencyTable() {
  elements.latencyRows.innerHTML = '';
  elements.latencyStats.innerHTML = '';

  if (state.runs.length === 0) {
    elements.latencyRows.innerHTML = '<tr><td colspan="7">No runs yet.</td></tr>';
    return;
  }

  for (const run of state.runs) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${run.id}</td>
      <td>${escapeHtml(run.caseId)}</td>
      <td>${formatMs(run.latency.stt)}</td>
      <td>${formatMs(run.latency.translate)}</td>
      <td>${formatMs(run.latency.tts)}</td>
      <td>${formatMs(run.latency.total)}</td>
      <td class="${run.status === '✓' ? 'pass' : 'fail'}">${run.status}</td>
    `;
    elements.latencyRows.append(row);
  }

  const stats = calculateStats(state.runs);
  elements.latencyStats.innerHTML = `
    <tr><td colspan="2">avg</td><td>${formatMs(stats.avg.stt)}</td><td>${formatMs(stats.avg.translate)}</td><td>${formatMs(stats.avg.tts)}</td><td>${formatMs(stats.avg.total)}</td><td></td></tr>
    <tr><td colspan="2">min</td><td>${formatMs(stats.min.stt)}</td><td>${formatMs(stats.min.translate)}</td><td>${formatMs(stats.min.tts)}</td><td>${formatMs(stats.min.total)}</td><td></td></tr>
    <tr><td colspan="2">max</td><td>${formatMs(stats.max.stt)}</td><td>${formatMs(stats.max.translate)}</td><td>${formatMs(stats.max.tts)}</td><td>${formatMs(stats.max.total)}</td><td></td></tr>
  `;
}

function renderLogs() {
  elements.debugConsole.innerHTML = '';
  for (const log of state.logs.slice(-120).reverse()) {
    const line = document.createElement('div');
    line.innerHTML = `<span>[${escapeHtml(log.timestamp)}]</span> <b>${escapeHtml(log.endpoint)}</b> status ${escapeHtml(log.status)}, ${formatMs(log.latency)}`;
    elements.debugConsole.append(line);
  }
}

function addLog(endpoint, latency, status, timestamp = new Date().toLocaleTimeString([], { hour12: false })) {
  state.logs.push({ timestamp, endpoint, latency, status });
  renderLogs();
}

async function drainAudioStream(stream) {
  const reader = stream.getReader();
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }

  const blob = new Blob(chunks, { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  elements.activeSpeaker.textContent = 'bot';

  await new Promise((resolve) => {
    audio.addEventListener('ended', () => {
      URL.revokeObjectURL(url);
      resolve();
    });
    audio.addEventListener('error', resolve);
    audio.play();
  });
}

function calculateStats(runs) {
  const keys = ['stt', 'translate', 'tts', 'total'];
  const output = {
    avg: {},
    min: {},
    max: {}
  };

  for (const key of keys) {
    const values = runs.map(run => run.latency[key]);
    output.avg[key] = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
    output.min[key] = Math.min(...values);
    output.max[key] = Math.max(...values);
  }

  return output;
}

function exportCsv() {
  const rows = [
    ['run', 'case', 'source_lang', 'target_lang', 'transcript', 'translation', 'stt_ms', 'translate_ms', 'tts_ms', 'total_ms', 'status']
  ];

  for (const run of state.runs) {
    rows.push([
      run.id,
      run.caseId,
      run.sourceLang,
      run.targetLang,
      run.transcript,
      run.translation,
      run.latency.stt,
      run.latency.translate,
      run.latency.tts,
      run.latency.total,
      run.status
    ]);
  }

  const blob = new Blob([rows.map(row => row.map(csvCell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `nativa-latency-${new Date().toISOString()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function stopStream() {
  state.stream?.getTracks().forEach(track => track.stop());
  state.audioContext?.close();
  state.stream = null;
  state.audioContext = null;
}

function pickMimeType() {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
}

function rms(data) {
  let sum = 0;
  for (const value of data) {
    const centered = (value - 128) / 128;
    sum += centered * centered;
  }
  return Math.sqrt(sum / data.length);
}

function langCode(language) {
  if (language === 'Russian') return 'RU';
  if (language === 'Uzbek') return 'UZ';
  return 'EN';
}

function formatMs(value) {
  if (!Number.isFinite(Number(value))) return '-';
  return `${Math.round(Number(value))}ms`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}
