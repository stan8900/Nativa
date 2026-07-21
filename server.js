import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import multer from 'multer';
import path from 'node:path';
import tls from 'node:tls';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }
});

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const ML_SERVER_BASE_URL = process.env.ML_SERVER_BASE_URL || 'http://127.0.0.1:8000';
const ML_SERVER = ML_SERVER_BASE_URL;
const DB_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DB_PATH = path.join(DB_DIR, 'nativa-db.json');
const SESSION_COOKIE = 'nativa_session';
const OAUTH_STATE_COOKIE = 'nativa_oauth_state';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || `https://${HOST}:${PORT}/auth/google/redirect`;
const FRONTEND_URL = process.env.FRONTEND_URL || '/';
const GMAIL_USER = process.env.GMAIL_USER || process.env.SMTP_USER || '';
const GMAIL_APP_PASSWORD = String(process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS || '').replace(/\s/g, '');
const OTP_TTL_MS = Number(process.env.OTP_TTL_MS || 10 * 60 * 1000);
const OTP_RESEND_MS = Number(process.env.OTP_RESEND_MS || 60 * 1000);
const CORS_ORIGINS = parseCorsOrigins(process.env.CORS_ORIGINS || process.env.FRONTEND_ORIGIN || '');
const USE_HTTPS = process.env.USE_HTTPS
  ? process.env.USE_HTTPS !== 'false'
  : !GOOGLE_CALLBACK_URL.startsWith('http://');
const COOKIE_SECURE = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE !== 'false'
  : USE_HTTPS;
const SESSION_COOKIE_SAME_SITE = process.env.SESSION_COOKIE_SAME_SITE || (COOKIE_SECURE ? 'none' : 'lax');
let activeVoiceId = process.env.DEFAULT_VOICE_ID || 'default';

app.use(corsMiddleware);
app.use(express.static(path.join(__dirname, 'docs')));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/stt', async (req, res) => {
  await proxyRequest(req, res, '/stt');
});

app.post('/api/translate', async (req, res) => {
  await proxyRequest(req, res, '/translate');
});

app.post('/api/tts-stream', async (req, res) => {
  await proxyRequest(req, res, '/tts-stream', { forceContentType: 'audio/wav', exposeXHeaders: true });
});

app.post('/api/voice-clone', async (req, res) => {
  await proxyRequest(req, res, '/voice-clone');
});

app.post('/api/pipeline', async (req, res) => {
  await proxyRequest(req, res, '/pipeline', { forceContentType: 'audio/wav', exposeXHeaders: true });
});

app.use(express.json({ limit: '1mb' }));

app.get('/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(500).send('Google OAuth is not configured.');
  }

  const state = crypto.randomBytes(24).toString('hex');
  res.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    maxAge: 1000 * 60 * 10
  });

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', GOOGLE_CALLBACK_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');

  res.redirect(url.toString());
});

app.get(['/auth/google/redirect', '/auth/google/callback'], async (req, res) => {
  try {
    const expectedState = getCookie(req, OAUTH_STATE_COOKIE);
    if (!expectedState || req.query.state !== expectedState) {
      throw statusError('Invalid Google OAuth state.', 400);
    }
    if (!req.query.code) {
      throw statusError('Google OAuth code is missing.', 400);
    }

    const profile = await fetchGoogleProfile(String(req.query.code));
    const db = readDb();
    const email = normalizeEmail(profile.email);
    let user = db.users.find(item => item.email === email);

    if (!user) {
      user = {
        id: crypto.randomUUID(),
        name: profile.name || email.split('@')[0],
        email,
        googleId: profile.sub,
        avatarUrl: profile.picture || '',
        passwordHash: '',
        sessions: [],
        createdAt: new Date().toISOString()
      };
      db.users.push(user);
    } else {
      user.googleId = user.googleId || profile.sub;
      user.avatarUrl = profile.picture || user.avatarUrl || '';
      user.name = user.name || profile.name || email.split('@')[0];
    }

    const session = createAuthSession(db, user.id);
    writeDb(db);
    clearOAuthStateCookie(res);
    setSessionCookie(res, session.id);
    res.redirect(FRONTEND_URL);
  } catch (error) {
    console.error('[Nativa Google OAuth error]', error);
    clearOAuthStateCookie(res);
    res.redirect('/?auth=google_error');
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password } = normalizeCredentials(req.body);
    const db = readDb();

    if (db.users.some(user => user.email === email)) {
      return res.status(409).json({ error: 'Email is already registered.' });
    }
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
      throw statusError('Gmail OTP is not configured on the server.', 500);
    }

    db.otpChallenges = cleanupOtpChallenges(db.otpChallenges);
    const existing = db.otpChallenges.find(item => item.email === email);
    const issuedAt = Date.now();

    if (existing && issuedAt - Number(existing.createdAtMs || 0) < OTP_RESEND_MS) {
      throw statusError('Please wait before requesting another code.', 429);
    }

    const passwordHash = await hashPassword(password);
    const code = createOtpCode();
    const challenge = {
      email,
      name,
      passwordHash,
      codeHash: await hashPassword(code),
      createdAtMs: issuedAt,
      expiresAtMs: issuedAt + OTP_TTL_MS,
      attempts: 0
    };

    db.otpChallenges = [
      ...db.otpChallenges.filter(item => item.email !== email),
      challenge
    ].slice(-100);

    await sendOtpEmail({ to: email, code });
    writeDb(db);
    res.status(202).json({ ok: true, message: 'Code sent.' });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || 'Registration failed.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const db = readDb();
    const user = db.users.find(item => item.email === email);

    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const session = createAuthSession(db, user.id);
    writeDb(db);
    setSessionCookie(res, session.id);
    res.json({ user: publicUser(user) });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Login failed.' });
  }
});

app.post('/api/request-otp', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const name = String(req.body?.name || '').trim();

    if (!isValidEmail(email)) {
      throw statusError('Enter a valid email.', 400);
    }
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
      throw statusError('Gmail OTP is not configured on the server.', 500);
    }

    const db = readDb();
    db.otpChallenges = cleanupOtpChallenges(db.otpChallenges);
    const existing = db.otpChallenges.find(item => item.email === email);
    const issuedAt = Date.now();

    if (existing && issuedAt - Number(existing.createdAtMs || 0) < OTP_RESEND_MS) {
      throw statusError('Please wait before requesting another code.', 429);
    }

    const code = createOtpCode();
    const challenge = {
      email,
      name: name.slice(0, 80),
      codeHash: await hashPassword(code),
      createdAtMs: issuedAt,
      expiresAtMs: issuedAt + OTP_TTL_MS,
      attempts: 0
    };

    db.otpChallenges = [
      ...db.otpChallenges.filter(item => item.email !== email),
      challenge
    ].slice(-100);

    await sendOtpEmail({ to: email, code });
    writeDb(db);
    res.json({ ok: true, message: 'Code sent.' });
  } catch (error) {
    console.error('[Nativa OTP request error]', error);
    res.status(error.status || 500).json({ error: error.message || 'Could not send OTP.' });
  }
});

app.post('/api/verify-otp', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || '').replace(/\D/g, '');
    const fallbackName = String(req.body?.name || '').trim();

    if (!isValidEmail(email)) {
      throw statusError('Enter a valid email.', 400);
    }
    if (code.length !== 6) {
      throw statusError('Enter the 6-digit code.', 400);
    }

    const db = readDb();
    db.otpChallenges = cleanupOtpChallenges(db.otpChallenges);
    const challenge = db.otpChallenges.find(item => item.email === email);

    if (!challenge || Number(challenge.expiresAtMs || 0) < Date.now()) {
      throw statusError('Code expired. Request a new one.', 400);
    }
    if (Number(challenge.attempts || 0) >= 5) {
      db.otpChallenges = db.otpChallenges.filter(item => item.email !== email);
      writeDb(db);
      throw statusError('Too many attempts. Request a new code.', 429);
    }

    const isValid = await verifyPassword(code, challenge.codeHash);
    if (!isValid) {
      challenge.attempts = Number(challenge.attempts || 0) + 1;
      writeDb(db);
      throw statusError('Invalid code.', 401);
    }

    let user = db.users.find(item => item.email === email);
    if (!user) {
      const name = challenge.name || fallbackName || email.split('@')[0];
      user = {
        id: crypto.randomUUID(),
        name,
        email,
        passwordHash: challenge.passwordHash || '',
        sessions: [],
        createdAt: new Date().toISOString()
      };
      db.users.push(user);
    }

    db.otpChallenges = db.otpChallenges.filter(item => item.email !== email);
    const session = createAuthSession(db, user.id);
    writeDb(db);
    setSessionCookie(res, session.id);
    res.json({ user: publicUser(user) });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || 'OTP verification failed.' });
  }
});

app.post('/api/logout', (req, res) => {
  const sessionId = getCookie(req, SESSION_COOKIE);
  if (sessionId) {
    const db = readDb();
    db.sessions = db.sessions.filter(session => session.id !== sessionId);
    writeDb(db);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated.' });
  res.json({ user: publicUser(auth.user) });
});

app.get('/api/user-sessions', (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated.' });
  res.json({ sessions: Array.isArray(auth.user.sessions) ? auth.user.sessions : [] });
});

app.put('/api/user-sessions', (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated.' });

  const sessions = Array.isArray(req.body?.sessions) ? req.body.sessions.slice(0, 20) : [];
  const user = auth.db.users.find(item => item.id === auth.user.id);
  user.sessions = sanitizeSessions(sessions);
  writeDb(auth.db);
  res.json({ ok: true, sessions: user.sessions });
});

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

async function proxyRequest(req, res, pathname, options = {}) {
  try {
    const response = await fetch(new URL(pathname, ML_SERVER).toString(), {
      method: req.method,
      headers: proxyHeaders(req.headers),
      body: req,
      duplex: 'half'
    });

    res.status(response.status);
    copyResponseHeaders(response, res, options);

    if (!response.body) {
      res.end();
      return;
    }

    Readable.fromWeb(response.body).pipe(res);
  } catch (error) {
    console.error(`[Nativa proxy error] ${pathname}`, error);
    if (!res.headersSent) {
      res.status(502).json({ error: error.message || 'ML proxy failed.' });
    } else {
      res.end();
    }
  }
}

function proxyHeaders(headers) {
  const forwarded = { ...headers };
  delete forwarded.host;
  delete forwarded.connection;
  delete forwarded['content-length'];
  return forwarded;
}

function copyResponseHeaders(response, res, options) {
  if (options.forceContentType) {
    res.setHeader('Content-Type', options.forceContentType);
  } else {
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
  }

  for (const [key, value] of response.headers) {
    if (key.startsWith('x-')) {
      res.setHeader(key, value);
    }
  }

  if (options.exposeXHeaders) {
    const xHeaders = [...response.headers.keys()].filter(key => key.startsWith('x-'));
    if (xHeaders.length) {
      res.setHeader('Access-Control-Expose-Headers', xHeaders.join(', '));
    }
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

function normalizeCredentials(body = {}) {
  const name = String(body.name || '').trim();
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');

  if (name.length < 2) throw statusError('Name must be at least 2 characters.', 400);
  if (!isValidEmail(email)) throw statusError('Enter a valid email.', 400);
  if (password.length < 6) throw statusError('Password must be at least 6 characters.', 400);

  return { name, email, password };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email);
}

function createOtpCode() {
  return String(crypto.randomInt(100000, 1000000));
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt);
  return `scrypt:${salt}:${derived}`;
}

async function verifyPassword(password, storedHash = '') {
  const [method, salt, expected] = storedHash.split(':');
  if (method !== 'scrypt' || !salt || !expected) return false;

  const actual = await scrypt(password, salt);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey.toString('hex'));
    });
  });
}

function createAuthSession(db, userId) {
  const session = {
    id: crypto.randomBytes(32).toString('hex'),
    userId,
    createdAt: new Date().toISOString()
  };
  db.sessions = db.sessions.filter(item => item.userId !== userId).slice(-20);
  db.sessions.push(session);
  return session;
}

function getAuth(req) {
  const sessionId = getCookie(req, SESSION_COOKIE);
  if (!sessionId) return null;

  const db = readDb();
  const session = db.sessions.find(item => item.id === sessionId);
  if (!session) return null;

  const user = db.users.find(item => item.id === session.userId);
  if (!user) return null;

  return { db, session, user };
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl || '',
    createdAt: user.createdAt
  };
}

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type, Accept');
    res.status(204).end();
    return;
  }

  next();
}

function isAllowedOrigin(origin) {
  if (CORS_ORIGINS.has(origin)) return true;

  try {
    const { hostname, protocol } = new URL(origin);
    return protocol === 'https:' && hostname.endsWith('.github.io');
  } catch {
    return false;
  }
}

function parseCorsOrigins(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean)
  );
}

async function fetchGoogleProfile(code) {
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: GOOGLE_CALLBACK_URL
    })
  });
  const tokenPayload = await readJson(tokenResponse);
  if (!tokenResponse.ok) {
    throw apiError('Google token exchange failed', tokenResponse, tokenPayload);
  }

  const profileResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: {
      Authorization: `Bearer ${tokenPayload.access_token}`
    }
  });
  const profile = await readJson(profileResponse);
  if (!profileResponse.ok) {
    throw apiError('Google profile request failed', profileResponse, profile);
  }
  if (!profile.email) {
    throw statusError('Google profile did not include an email.', 400);
  }

  return profile;
}

function sanitizeSessions(sessions) {
  return sessions.map(session => ({
    id: String(session.id || crypto.randomUUID()),
    title: String(session.title || 'Untitled session').slice(0, 120),
    date: String(session.date || new Date().toISOString()),
    srcLang: String(session.srcLang || 'RU').slice(0, 8),
    tgtLang: String(session.tgtLang || 'EN').slice(0, 8),
    duration: Math.max(0, Number(session.duration) || 0),
    replicas: Array.isArray(session.replicas) ? session.replicas.slice(-5) : []
  }));
}

function cleanupOtpChallenges(challenges = []) {
  const nowMs = Date.now();
  return Array.isArray(challenges)
    ? challenges.filter(item => Number(item.expiresAtMs || 0) > nowMs)
    : [];
}

async function sendOtpEmail({ to, code }) {
  const subject = 'Your Nativa login code';
  const body = [
    `Your Nativa verification code is ${code}.`,
    '',
    `This code expires in ${Math.max(1, Math.round(OTP_TTL_MS / 60000))} minutes.`,
    'If you did not request this code, you can ignore this email.'
  ].join('\r\n');

  await sendGmailMessage({
    to,
    subject,
    text: body
  });
}

function sendGmailMessage({ to, subject, text }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(465, 'smtp.gmail.com', { servername: 'smtp.gmail.com' });
    let buffer = '';
    const commands = [
      'EHLO nativa.local',
      'AUTH LOGIN',
      Buffer.from(GMAIL_USER).toString('base64'),
      Buffer.from(GMAIL_APP_PASSWORD).toString('base64'),
      `MAIL FROM:<${GMAIL_USER}>`,
      `RCPT TO:<${to}>`,
      'DATA',
      buildEmailMessage({ to, subject, text }),
      'QUIT'
    ];
    let commandIndex = 0;

    socket.setTimeout(15000);

    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (!buffer.endsWith('\r\n')) return;

      const lines = buffer.trim().split(/\r?\n/);
      const lastLine = lines[lines.length - 1] || '';
      if (/^\d{3}-/.test(lastLine)) return;

      const status = Number(lastLine.slice(0, 3));
      buffer = '';

      if (status >= 400) {
        socket.destroy();
        reject(statusError(`Gmail SMTP failed: ${lastLine}`, 502));
        return;
      }

      if (commandIndex >= commands.length) {
        socket.end();
        resolve();
        return;
      }

      socket.write(`${commands[commandIndex]}\r\n`);
      commandIndex += 1;
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(statusError('Gmail SMTP timed out.', 504));
    });
    socket.on('error', error => reject(error));
  });
}

function buildEmailMessage({ to, subject, text }) {
  const headers = [
    `From: ${mimeHeader('Nativa')} <${GMAIL_USER}>`,
    `To: <${to}>`,
    `Subject: ${mimeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit'
  ];
  const safeText = String(text || '').replace(/^\./gm, '..');
  return `${headers.join('\r\n')}\r\n\r\n${safeText}\r\n.`;
}

function mimeHeader(value) {
  const text = String(value || '');
  return /^[\x20-\x7e]*$/.test(text)
    ? text
    : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function readDb() {
  ensureDb();
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      otpChallenges: cleanupOtpChallenges(parsed.otpChallenges)
    };
  } catch {
    return { users: [], sessions: [], otpChallenges: [] };
  }
}

function writeDb(db) {
  ensureDb();
  fs.writeFileSync(DB_PATH, `${JSON.stringify(db, null, 2)}\n`);
}

function ensureDb() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, `${JSON.stringify({ users: [], sessions: [], otpChallenges: [] }, null, 2)}\n`);
}

function setSessionCookie(res, sessionId) {
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: SESSION_COOKIE_SAME_SITE,
    secure: COOKIE_SECURE,
    maxAge: 1000 * 60 * 60 * 24 * 30
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: SESSION_COOKIE_SAME_SITE,
    secure: COOKIE_SECURE
  });
}

function clearOAuthStateCookie(res) {
  res.clearCookie(OAUTH_STATE_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE
  });
}

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const server = USE_HTTPS
  ? https.createServer({
    key: fs.readFileSync('./localhost+1-key.pem'),
    cert: fs.readFileSync('./localhost+1.pem')
  }, app)
  : http.createServer(app);

server.listen(PORT, HOST, () => {
  const protocol = USE_HTTPS ? 'https' : 'http';
  console.log(`Nativa web app running at ${protocol}://${HOST}:${PORT}`);
  console.log(`Nativa ML server expected at ${ML_SERVER_BASE_URL}`);
  if (GOOGLE_CLIENT_ID) console.log(`Google OAuth callback at ${GOOGLE_CALLBACK_URL}`);
});
