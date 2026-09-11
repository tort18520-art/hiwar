/* ============================================================
   Hiwar (حوار) — خادم ذكي بمعالجة أخطاء تلقائية (Self-Healing)
   ------------------------------------------------------------
   - يخدم الواجهة من /public
   - يعيد المحاولة تلقائياً عند أخطاء مؤقتة (شبكة/حصة/5xx)
   - يبدّل نموذج Gemini تلقائياً عند عدم توفره
   - يحوّل لمزوّد بديل (Groq/OpenRouter) عند توفر مفاتيح بيئة
   - مهلات زمنية تمنع التعليق، وحرّاس أخطاء يمنعون الانهيار
   - يبث الردود كـ Server-Sent Events
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// تحميل ملف .env (المفاتيح السرية) — بدون أي مكتبات خارجية
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = raw.replace(/\r$/, '').trim();
      if (!t || t[0] === '#' || t.startsWith('//')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'")) v = v.slice(1, -1);
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  }
} catch (e) { /* تجاهل أخطاء قراءة .env */ }

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');
const companion = require('./companion');
const FETCH_TIMEOUT_MS = 12000;   // مهلة الاتصال بالمزوّد
const STALL_MS = 30000;           // مهلة توقف البث
const RETRIES = 1;                // عدد إعادة المحاولة لكل محاولة
const BACKOFF_BASE_MS = 600;

// نماذج بديلة تُجرَّب تلقائياً إذا فشل النموذج الأساسي
// ملاحظة: حصة الطبقة المجانية لكل نموذج على حدة، ففشل 3.6-flash لا يعني فشل البقية
const GEMINI_FALLBACK_MODELS = ['gemini-flash-lite-latest', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.7-flash'];

// حالة الخادم (تُعرض في /api/selfcheck)
const state = {
  startedAt: Date.now(),
  requests: 0,
  failures: 0,
  lastError: null,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

/* ---------- helpers ---------- */

class ProviderError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;        // NETWORK | AUTH | MODEL | QUOTA | SERVER | HTTP
    this.status = status || 0;
  }
}

function log(...args) {
  try { console.log(`[${new Date().toISOString()}]`, ...args); } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
}

function sendEvent(res, payload) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendDone(res) {
  if (res.destroyed || res.writableEnded) return;
  res.write('data: [DONE]\n\n');
  res.end();
}

function sendError(res, message) {
  if (res.destroyed || res.writableEnded) return;
  try { sendEvent(res, { error: message }); } catch {}
  try { res.end(); } catch {}
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 8_000_000) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function extractRetryAfter(txt) {
  // يستخرج مهلة الانتظار من رسالة Google: "Please retry in 38.441s" أو حقل retryDelay
  const m = (txt || '').match(/retry in ([\d.]+)s/i);
  if (m) return Math.ceil(parseFloat(m[1]));
  const d = (txt || '').match(/"retryDelay":\s*"([\d.]+)s"/i);
  if (d) return Math.ceil(parseFloat(d[1]));
  return null;
}

function classifyUpstream(status, txt) {
  const s = (txt || '').toLowerCase();
  const retryAfter = extractRetryAfter(txt);
  const keyInvalid = /api key not valid|invalid api key|api_key_invalid|permission denied|not authorized|not authenticated|api key is not/.test(s);
  if (status === 401 || status === 403 || keyInvalid) {
    const e = new ProviderError('AUTH', txt.slice(0, 300) || 'مفتاح غير صحيح أو غير مصرّح', status || 401);
    if (retryAfter) e.retryAfter = retryAfter;
    return e;
  }
  if (status === 404 || /not found|no longer available|does not exist|invalid model|model.*not/.test(s)) {
    const e = new ProviderError('MODEL', txt.slice(0, 300) || 'النموذج غير موجود', status);
    if (retryAfter) e.retryAfter = retryAfter;
    return e;
  }
  if (status === 429 || /quota|rate.?limit|too many|exceeded|insufficient|overloaded|busy|resource_exhausted/.test(s)) {
    const e = new ProviderError('QUOTA', txt.slice(0, 300) || 'تم تجاوز الحصة أو الحد', status);
    if (retryAfter) e.retryAfter = retryAfter;
    return e;
  }
  if (status >= 500) {
    const e = new ProviderError('SERVER', txt.slice(0, 300) || 'خطأ في خادم المزوّد', status);
    if (retryAfter) e.retryAfter = retryAfter;
    return e;
  }
  const e = new ProviderError('HTTP', txt.slice(0, 300) || `خطأ ${status}`, status);
  if (retryAfter) e.retryAfter = retryAfter;
  return e;
}

function isRetryable(err) {
  // ملاحظة: لا نعيد المحاولة على QUOTA (حصة ممتلئة) — إعادة المحاولة فوراً لن تنجح وتحرق الطلبات
  return err && (err.code === 'NETWORK' || err.code === 'SERVER');
}

/* ---------- مرونة الإنتاج (Production Resilience) ---------- */

// تراجع أسي مع تشويش (Jittered Exponential Backoff) — يمنع تزامن الطلبات ويحمي المزوّد
function backoffDelay(attempt) {
  const base = BACKOFF_BASE_MS * Math.pow(2, attempt);
  return Math.round(base * (0.5 + Math.random()));
}

// قاطع الدائرة (Circuit Breaker): بعد فشل متتالٍ يتجمّد الطريق على المزوّد فترة ثم يسمح بمحاولة تجريبية
const circuits = new Map();
function breakerKey(kind, cfg) {
  return kind + '|' + ((cfg && cfg.baseUrl) || '') + '|' + ((cfg && cfg.model) || '');
}
function breakerState(key) {
  let c = circuits.get(key);
  if (!c) { c = { fails: 0, openUntil: 0, cooldown: 8000 }; circuits.set(key, c); }
  return c;
}
function breakerAllow(key) {
  const c = breakerState(key);
  return Date.now() >= c.openUntil;
}
function breakerRemaining(key) {
  const c = breakerState(key);
  return Math.max(1, Math.ceil((c.openUntil - Date.now()) / 1000));
}
function breakerSuccess(key) {
  const c = breakerState(key);
  c.fails = 0; c.openUntil = 0; c.cooldown = 8000;
}
function breakerFail(key) {
  const c = breakerState(key);
  c.fails++;
  if (c.fails >= 2) {
    c.cooldown = Math.min(c.cooldown * 2, 90000);
    c.openUntil = Date.now() + c.cooldown;
    c.fails = 0;
    log(`⛔ قاطع الدائرة فُتح لـ ${key} — تجميد ${Math.round(c.cooldown / 1000)} ثانية`);
  }
}

/* ---------- فتح الاتصالات (مع إعادة المحاولة) ---------- */

async function openOpenAI(cfg, messages) {
  const { baseUrl, apiKey, model } = cfg || {};
  const url = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions';
  let last;
  for (let i = 0; i <= RETRIES; i++) {
    let up;
    try {
      up = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model || 'gpt-4o-mini', messages, stream: true }),
      }, FETCH_TIMEOUT_MS);
    } catch (e) {
      last = new ProviderError('NETWORK', 'تعذّر الاتصال بمزوّد الذكاء الاصطناعي', 0);
      if (i < RETRIES) await sleep(backoffDelay(i));
      continue;
    }
    if (up.ok) return up;
    const txt = await up.text().catch(() => '');
    last = classifyUpstream(up.status, txt);
    if (!isRetryable(last) || i >= RETRIES) break;
    await sleep(backoffDelay(i));
  }
  throw last;
}

async function openGemini(cfg, messages) {
  const { apiKey, model } = cfg || {};
  const m = model || 'gemini-flash-lite-latest';
  const systemParts = messages.filter((x) => x.role === 'system').map((x) => ({ text: x.content }));
  const contents = messages
    .filter((x) => x.role === 'user' || x.role === 'assistant')
    .map((x) => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }] }));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const body = { contents };
  if (systemParts.length) body.systemInstruction = { parts: systemParts };

  let last;
  for (let i = 0; i <= RETRIES; i++) {
    let up;
    try {
      up = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, FETCH_TIMEOUT_MS);
    } catch (e) {
      last = new ProviderError('NETWORK', 'تعذّر الاتصال بـ Google Gemini', 0);
      if (i < RETRIES) await sleep(backoffDelay(i));
      continue;
    }
    if (up.ok) return up;
    const txt = await up.text().catch(() => '');
    last = classifyUpstream(up.status, txt);
    if (!isRetryable(last) || i >= RETRIES) break;
    await sleep(backoffDelay(i));
  }
  throw last;
}

async function openAnthropic(cfg, messages) {
  const { apiKey, model } = cfg || {};
  const system = messages.filter((x) => x.role === 'system').map((x) => x.content).join('\n');
  const msgs = messages.filter((x) => x.role === 'user' || x.role === 'assistant').map((x) => ({ role: x.role, content: x.content }));

  let last;
  for (let i = 0; i <= RETRIES; i++) {
    let up;
    try {
      up = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: model || 'claude-3-5-sonnet-latest',
          max_tokens: 2048,
          ...(system ? { system } : {}),
          messages: msgs,
          stream: true,
        }),
      }, FETCH_TIMEOUT_MS);
    } catch (e) {
      last = new ProviderError('NETWORK', 'تعذّر الاتصال بـ Anthropic', 0);
      if (i < RETRIES) await sleep(backoffDelay(i));
      continue;
    }
    if (up.ok) return up;
    const txt = await up.text().catch(() => '');
    last = classifyUpstream(up.status, txt);
    if (!isRetryable(last) || i >= RETRIES) break;
    await sleep(backoffDelay(i));
  }
  throw last;
}

/* ---------- ضخّ البث (مع مهلة توقف) ---------- */

async function pumpSSE(res, upstream, onData) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let stall = setTimeout(() => { try { reader.cancel(); } catch {} }, STALL_MS);
  try {
    while (true) {
      const { done, value } = await reader.read();
      clearTimeout(stall);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line.startsWith('data:')) onData(line.slice(5).trim());
      }
      stall = setTimeout(() => { try { reader.cancel(); } catch {} }, STALL_MS);
    }
  } finally {
    clearTimeout(stall);
    try { reader.releaseLock(); } catch {}
  }
}

async function streamOpenAIBody(res, upstream) {
  await pumpSSE(res, upstream, (data) => {
    if (data === '[DONE]') return;
    try {
      const j = JSON.parse(data);
      const delta = j.choices && j.choices[0] && j.choices[0].delta;
      const t = delta && (delta.content || delta.reasoning_content);
      if (t) sendEvent(res, { t });
    } catch { /* skip malformed */ }
  });
}

async function streamGeminiBody(res, upstream) {
  await pumpSSE(res, upstream, (data) => {
    try {
      const j = JSON.parse(data);
      const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
      if (parts) {
        const t = parts.map((p) => p.text || '').join('');
        if (t) sendEvent(res, { t });
      }
    } catch { /* skip */ }
  });
}

async function streamAnthropicBody(res, upstream) {
  await pumpSSE(res, upstream, (data) => {
    try {
      const j = JSON.parse(data);
      if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') {
        sendEvent(res, { t: j.delta.text });
      }
    } catch { /* skip */ }
  });
}

/* ---------- قائمة المحاولات + التحويل التلقائي ---------- */

function buildAttempts(cfg) {
  const provider = cfg.provider || 'openai';
  const attempts = [];

  if (provider === 'gemini') {
    const models = [];
    if (cfg.model) models.push(cfg.model);
    for (const m of GEMINI_FALLBACK_MODELS) if (!models.includes(m)) models.push(m);
    for (const m of models) attempts.push({ kind: 'gemini', label: 'Gemini (' + m + ')', cfg: { ...cfg, model: m } });
  } else if (provider === 'anthropic') {
    attempts.push({ kind: 'anthropic', label: 'Anthropic Claude', cfg });
  } else {
    attempts.push({ kind: 'openai', label: cfg.model || 'OpenAI', cfg });
  }

  // بدائل عبر المزوّدات عند توفر مفاتيح بيئة (لا تُستخدم نفس المفتاح الأساسي)
  if (process.env.GROQ_API_KEY) {
    attempts.push({
      kind: 'openai', label: 'Groq (بديل تلقائي)',
      cfg: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: process.env.GROQ_API_KEY, model: 'llama-3.3-70b-versatile' },
    });
  }
  if (process.env.OPENROUTER_API_KEY) {
    attempts.push({
      kind: 'openai', label: 'OpenRouter (بديل تلقائي)',
      cfg: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY, model: 'meta-llama/llama-3.3-70b-instruct:free' },
    });
  }
  return attempts;
}

function friendlyProviderError(err) {
  if (!err) return 'تعذّر الحصول على ردّ — حاول مرة أخرى.';
  switch (err.code) {
    case 'AUTH': return 'المفتاح غير صحيح أو غير مصرّح — تحقّق من المفتاح في الإعدادات ⚙️';
    case 'MODEL': return 'النموذج المطلوب غير متاح — جرّب نموذجاً آخر من الإعدادات ⚙️';
    case 'QUOTA':
      if (err.retryAfter) return `الحصة ممتلئة مؤقتاً — إعادة المحاولة بعد ${err.retryAfter} ثانية…`;
      return 'استنفدت الحصة المجانية أو الحد اليومي — انتظر قليلاً أو بدّل المزوّد من الإعدادات ⚙️';
    case 'SERVER': return 'مزوّد الذكاء الاصطناعي يعاني مشكلة مؤقتة — حاول بعد قليل.';
    case 'NETWORK': return 'تعذّر الاتصال بمزوّد الذكاء الاصطناعي — تحقّق من الإنترنت وحاول مجدداً.';
    default: return 'تعذّر الحصول على ردّ — حاول مرة أخرى.';
  }
}

async function streamWithFailover(res, cfg, messages) {
  const attempts = buildAttempts(cfg);
  let lastErr = null;
  let prevKey = null;

  for (let i = 0; i < attempts.length; i++) {
    if (res.destroyed || res.writableEnded) return;
    const a = attempts[i];

    // قاطع الدائرة: إذا كان الطريق متجمداً بعد فشل سابق، انتقل للبديل فوراً
    const ck = breakerKey(a.kind, a.cfg);
    if (!breakerAllow(ck)) {
      lastErr = new ProviderError('QUOTA', 'المزوّد تحت ضغط مؤقت', 0);
      lastErr.retryAfter = breakerRemaining(ck);
      log(`⏭ تجاوز ${a.label} — قاطع الدائرة مفتوح (${lastErr.retryAfter} ث)`);
      continue;
    }

    // تجاوز المفتاح الفاشل فقط عند خطأ المفتاح (AUTH) — أما الحصة (QUOTA) فلكل نموذج حصة مستقلة
    if (lastErr && lastErr.code === 'AUTH' && a.cfg.apiKey && prevKey && a.cfg.apiKey === prevKey) {
      log(`تجاوز ${a.label} — نفس المفتاح الفاشل`);
      continue;
    }
    prevKey = a.cfg.apiKey;

    let upstream;
    try {
      if (a.kind === 'gemini') upstream = await openGemini(a.cfg, messages);
      else if (a.kind === 'anthropic') upstream = await openAnthropic(a.cfg, messages);
      else upstream = await openOpenAI(a.cfg, messages);
    } catch (e) {
      const err = (e && e.code) ? e : new ProviderError('NETWORK', (e && e.message) || 'خطأ', 0);
      lastErr = err;
      state.lastError = { code: err.code, status: err.status, at: new Date().toISOString(), message: String(err.message).slice(0, 200) };
      // الأخطاء المؤقتة فقط تُفعّل قاطع الدائرة (لا أخطاء الإعداد الدائمة)
      if (err.code === 'NETWORK' || err.code === 'SERVER' || err.code === 'QUOTA') breakerFail(ck);
      log(`✖ المحاولة ${i + 1}/${attempts.length} (${a.label}) فشلت: [${err.code}] ${err.message}`);
      continue;
    }

    breakerSuccess(ck);
    if (i > 0) sendEvent(res, { notice: 'تم التحويل تلقائياً إلى ' + a.label + ' بعد تعذّر الخيار الأساسي.' });

    try {
      if (a.kind === 'gemini') await streamGeminiBody(res, upstream);
      else if (a.kind === 'anthropic') await streamAnthropicBody(res, upstream);
      else await streamOpenAIBody(res, upstream);
      sendDone(res);
      log(`✔ نجح الرد عبر ${a.label}`);
      return;
    } catch (se) {
      // فشل في منتصف البث — لا يمكن التحويل بأمان، أخبر العميل بصدق مع إعادة محاولة تلقائية
      state.lastError = { code: 'STREAM', at: new Date().toISOString(), message: String((se && se.message) || 'stream error').slice(0, 200) };
      sendEvent(res, { error: 'انقطع البث أثناء الرد — إعادة المحاولة تلقائياً…', retryAfter: 3 });
      res.end();
      return;
    }
  }

  state.failures++;
  const msg = friendlyProviderError(lastErr);
  // الأخطاء المؤقتة (شبكة/حصة/خادم) → إعادة محاولة تلقائية من العميل مع عدّ تنازلي
  if (lastErr && lastErr.retryAfter) {
    sendEvent(res, { error: msg, retryAfter: Math.min(lastErr.retryAfter, 120) });
    res.end();
  } else if (lastErr && (lastErr.code === 'NETWORK' || lastErr.code === 'SERVER')) {
    sendEvent(res, { error: msg, retryAfter: 5 });
    res.end();
  } else {
    sendError(res, msg);
  }
}

/* ---------- TTS helpers ---------- */

const ttsCache = new Map(); // مفتاح lang|text → Buffer (ذاكرة مؤقتة بسيطة)

function splitForTTS(text, maxLen) {
  maxLen = maxLen || 180;
  const sentences = String(text).replace(/([.!?؟۔])\s+/g, '$1\n').split('\n').map((s) => s.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  const push = (s) => { s = s.trim(); if (s) chunks.push(s); };
  for (const s of sentences) {
    if (s.length > maxLen) {
      if (cur) { push(cur); cur = ''; }
      const words = s.split(' ');
      let piece = '';
      for (const w of words) {
        if ((piece + ' ' + w).trim().length > maxLen) { push(piece); piece = w; }
        else piece = piece ? piece + ' ' + w : w;
      }
      if (piece) push(piece);
    } else if ((cur + ' ' + s).trim().length > maxLen) {
      push(cur); cur = s;
    } else {
      cur = cur ? cur + ' ' + s : s;
    }
  }
  push(cur);
  return chunks;
}

async function fetchGoogleTTS(text, lang) {
  const key = lang + '|' + text;
  if (ttsCache.has(key)) return ttsCache.get(key);
  const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl='
    + encodeURIComponent(lang) + '&q=' + encodeURIComponent(text);
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  }, 12000);
  if (!res.ok) throw new Error('TTS upstream ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length < 200) throw new Error('TTS empty');
  if (ttsCache.size > 100) { const first = ttsCache.keys().next().value; ttsCache.delete(first); }
  ttsCache.set(key, buf);
  return buf;
}

/* ---------- static file serving ---------- */

function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  p = decodeURIComponent(p);
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(data);
  });
}

/* ---------- server ---------- */

const server = http.createServer(async (req, res) => {
  // منع انهيار الخادم عند انقطاع اتصال العميل أثناء بث الرد
  req.on('error', () => {});
  res.on('error', () => {});
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  // وحدة الرفيقة الذكية (حسابات + ملف شخصي + مواقيت صلاة)
  try {
    if (await companion.handle(req, res, url)) return;
  } catch (e) {
    log('companion error:', (e && e.message) || e);
    return sendJSON(res, 500, { error: 'خطأ في الخادم' });
  }

  if (url.pathname === '/api/health') {
    return sendJSON(res, 200, { ok: true, name: 'Hiwar', version: '1.0', uptime: Math.round((Date.now() - state.startedAt) / 1000) });
  }

  if (url.pathname === '/api/selfcheck') {
    return sendJSON(res, 200, {
      ok: true,
      uptime: Math.round((Date.now() - state.startedAt) / 1000),
      requests: state.requests,
      failures: state.failures,
      lastError: state.lastError,
      memoryMB: Math.round(process.memoryUsage().rss / 1048576),
      envKeys: {
        gemini: !!process.env.GEMINI_API_KEY,
        openai: !!process.env.OPENAI_API_KEY,
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        groq: !!process.env.GROQ_API_KEY,
        openrouter: !!process.env.OPENROUTER_API_KEY,
      },
    });
  }

  /* ---------- TTS: نطق بشري فصيح (Google) ---------- */
  if (url.pathname === '/api/tts') {
    const text = String(url.searchParams.get('text') || '').trim();
    const lang = String(url.searchParams.get('lang') || 'ar').slice(0, 8).replace(/[^a-zA-Z-]/g, '') || 'ar';
    if (!text || text.length > 4000) return sendJSON(res, 400, { error: 'bad text' });
    const chunks = splitForTTS(text);
    try {
      const bufs = [];
      for (const c of chunks) {
        bufs.push(await fetchGoogleTTS(c, lang));
      }
      const total = Buffer.concat(bufs);
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'public, max-age=86400',
        'Content-Length': total.length,
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(total);
    } catch (e) {
      log('tts error:', e && e.message);
      return sendJSON(res, 502, { error: 'tts failed' });
    }
  }

  if (url.pathname === '/api/chat' && req.method === 'POST') {
    state.requests++;
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJSON(res, 400, { error: 'Invalid JSON' });
    }
    const cfg = body.config || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) return sendJSON(res, 400, { error: 'empty messages' });

    // إن لم يُرسل المتصفح مفتاحاً، استخدم مفتاح البيئة من الاستضافة
    if (!cfg.apiKey) {
      const b = (cfg.baseUrl || '').toLowerCase();
      if (cfg.provider === 'gemini') cfg.apiKey = process.env.GEMINI_API_KEY || '';
      else if (cfg.provider === 'anthropic') cfg.apiKey = process.env.ANTHROPIC_API_KEY || '';
      else if (b.includes('groq')) cfg.apiKey = process.env.GROQ_API_KEY || '';
      else if (b.includes('openrouter')) cfg.apiKey = process.env.OPENROUTER_API_KEY || '';
      else cfg.apiKey = process.env.OPENAI_API_KEY || '';
    }

    sse(res);
    try {
      return await streamWithFailover(res, cfg, messages);
    } catch (e) {
      state.failures++;
      state.lastError = { code: 'INTERNAL', at: new Date().toISOString(), message: String((e && e.message) || e).slice(0, 200) };
      sendError(res, 'خطأ في الخادم: ' + (e && e.message));
    }
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res, url.pathname);
  }

  sendJSON(res, 405, { error: 'Method not allowed' });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`Hiwar (حوار) running at http://0.0.0.0:${PORT}`);
});

// شبكة أمان: لا تدع أي خطأ غير متوقع يوقف الخادم
process.on('uncaughtException', (e) => log('uncaughtException:', (e && e.message) || e));
process.on('unhandledRejection', (e) => log('unhandledRejection:', (e && e.message) || e));
