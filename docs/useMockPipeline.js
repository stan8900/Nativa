const MOCK_TRANSCRIPTS = [
  'Добрый день',
  'Как дела?',
  'Привет, я хочу заказать столик на двоих на пятницу',
  'Hello, my name is John and I want to schedule a meeting',
  'Yes'
];

export async function runMockPipeline(audioBlob, options = {}) {
  const logs = [];
  const transcript = options.transcript || pickTranscript(options.caseId);
  const target = options.targetLang || 'English';

  const sttMs = await mockStep(logs, '/stt', 150, 300);
  const translation = mockTranslate(transcript, target, options.caseId);
  const translateMs = await mockStep(logs, '/translate', 80, 150);
  const ttsMs = await mockStep(logs, '/tts-stream', 200, 400);

  return {
    transcript,
    translation,
    audioBuffer: makeSilentAudioBuffer(),
    latency: {
      stt: sttMs,
      translate: translateMs,
      tts: ttsMs,
      total: sttMs + translateMs + ttsMs
    },
    logs
  };
}

function pickTranscript(caseId) {
  if (caseId === 'K-01') return MOCK_TRANSCRIPTS[3];
  if (caseId === 'K-02') return MOCK_TRANSCRIPTS[2];
  if (caseId === 'K-03') return MOCK_TRANSCRIPTS[4];
  if (caseId === 'K-05-1') return 'I work at a bank';
  if (caseId === 'K-05-2') return "It's been stressful lately";
  return MOCK_TRANSCRIPTS[Math.floor(Math.random() * MOCK_TRANSCRIPTS.length)];
}

function mockTranslate(text, targetLang, caseId) {
  if (caseId === 'K-01') return 'Здравствуйте, меня зовут Джон, и я хочу назначить встречу.';
  if (caseId === 'K-02') return "Hi, I'd like to book a table for two this Friday.";
  if (caseId === 'K-03') return targetLang === 'Russian' ? 'Да.' : 'Yes.';
  if (caseId === 'K-05-1') return 'Я работаю в банке.';
  if (caseId === 'K-05-2') return 'В последнее время работа в банке была напряжённой.';
  if (targetLang === 'Russian') return 'Добрый день.';
  if (targetLang === 'Uzbek') return 'Xayrli kun.';
  return 'Good afternoon.';
}

async function mockStep(logs, endpoint, min, max) {
  const latency = randomInt(min, max);
  await sleep(latency);
  logs.push({
    timestamp: new Date().toLocaleTimeString([], { hour12: false }),
    endpoint,
    latency,
    status: 200
  });
  return latency;
}

function makeSilentAudioBuffer() {
  return new ArrayBuffer(0);
}

function randomInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
