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

const STATIC_ROOT_FALLBACK = ['index.html', 'app.js', 'client.js', 'companion.js', 'styles.css', 'sw.js', 'bg_alpine.jpg', 'bg_custom.jpg'];

function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  p = decodeURIComponent(p);
  let file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  const deliver = (f) => {
    fs.readFile(f, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      const ext = path.extname(f).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(data);
    });
  };
  if (fs.existsSync(file)) return deliver(file);
  // إن لم يوجد داخل public/ فقد تكون ملفات الواجهة مرفوعة في جذر المشروع
  const name = path.basename(file);
  if (STATIC_ROOT_FALLBACK.includes(name)) {
    const alt = path.normalize(path.join(__dirname, name));
    if (alt !== file && fs.existsSync(alt)) return deliver(alt);
  }
  return deliver(file);
}


/* ---------- وحدة الرفيقة الذكية (مدمجة) ---------- */
const companion = (function () {
  'use strict';
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');







const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

/* ---------- تخزين JSON آمن ---------- */
function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    }
  } catch {}
  return fallback;
}
function saveJSON(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj));
    return true;
  } catch { return false; }
}

let users = loadJSON(USERS_FILE, {});
let profiles = loadJSON(PROFILES_FILE, {});
let sessions = loadJSON(SESSIONS_FILE, {});

/* ---------- تشفير كلمات المرور ---------- */
function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
function makeSalt() { return crypto.randomBytes(16).toString('hex'); }
function makeToken() { return crypto.randomBytes(32).toString('hex'); }
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

/* ---------- مدن سعودية بإحداثياتها ---------- */
const CITIES = [
  { name: 'الخبر', en: 'al khobar', lat: 26.2172, lng: 50.1971 },
  { name: 'الدمام', en: 'dammam', lat: 26.4207, lng: 50.0888 },
  { name: 'الظهران', en: 'dhahran', lat: 26.2667, lng: 50.15 },
  { name: 'القطيف', en: 'qatif', lat: 26.52, lng: 49.98 },
  { name: 'الجبيل', en: 'jubail', lat: 27.0, lng: 49.66 },
  { name: 'الأحساء', en: 'al ahsa', lat: 25.383, lng: 49.5858 },
  { name: 'الرياض', en: 'riyadh', lat: 24.7136, lng: 46.6753 },
  { name: 'جدة', en: 'jeddah', lat: 21.4858, lng: 39.1925 },
  { name: 'مكة المكرمة', en: 'makkah', lat: 21.3891, lng: 39.8579 },
  { name: 'المدينة المنورة', en: 'madinah', lat: 24.5247, lng: 39.5692 },
  { name: 'أبها', en: 'abha', lat: 18.2164, lng: 42.5053 },
  { name: 'الطائف', en: 'taif', lat: 21.2703, lng: 40.4158 },
  { name: 'تبوك', en: 'tabuk', lat: 28.3838, lng: 36.5665 },
  { name: 'بريدة', en: 'buraidah', lat: 26.326, lng: 43.975 },
  { name: 'حائل', en: 'hail', lat: 27.5219, lng: 41.6907 },
  { name: 'نجران', en: 'najran', lat: 17.493, lng: 44.1277 },
  { name: 'جازان', en: 'jazan', lat: 16.8894, lng: 42.5706 },
  { name: 'رابغ', en: 'rabigh', lat: 22.8, lng: 39.03 },
  { name: 'ينبع', en: 'yanbu', lat: 24.0898, lng: 38.0634 },
  { name: 'الخفجي', en: 'khafji', lat: 28.439, lng: 48.4913 },
];

function findCity(input) {
  if (!input) return null;
  const q = String(input).trim().toLowerCase();
  for (const c of CITIES) {
    if (c.name === input || c.en === q || c.name.includes(input)) return c;
  }
  return null;
}

/* ---------- حساب مواقيت الصلاة (طريقة أم القرى) ---------- */
function fixAngle(a) { a = a - 360 * Math.floor(a / 360); return a < 0 ? a + 360 : a; }
function fixHour(a) { a = a - 24 * Math.floor(a / 24); return a < 0 ? a + 24 : a; }
function dsin(d) { return Math.sin(d * Math.PI / 180); }
function dcos(d) { return Math.cos(d * Math.PI / 180); }
function dtan(d) { return Math.tan(d * Math.PI / 180); }
function darcsin(x) { return Math.asin(x) * 180 / Math.PI; }
function darccos(x) { return Math.acos(x) * 180 / Math.PI; }
function darccot(x) { return Math.atan(1 / x) * 180 / Math.PI; }
function darctan2(y, x) { return Math.atan2(y, x) * 180 / Math.PI; }

function julian(year, month, day) {
  if (month <= 2) { year -= 1; month += 12; }
  const A = Math.floor(year / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (year + 4716)) + Math.floor(30.6001 * (month + 1)) + day + B - 1524.5;
}

// تعود: declination و equation of time
function sunPosition(jd) {
  const D = jd - 2451545.0;
  const g = fixAngle(357.529 + 0.98560028 * D);
  const q = fixAngle(280.459 + 0.98564736 * D);
  const L = fixAngle(q + 1.915 * dsin(g) + 0.020 * dsin(2 * g));
  const e = 23.439 - 0.00000036 * D;
  const RA = darctan2(dcos(e) * dsin(L), dcos(L)) / 15;
  const eqt = q / 15 - fixHour(RA);
  const decl = darcsin(dsin(e) * dsin(L));
  return { declination: decl, equation: eqt };
}

function computePrayerTimes(dateObj, lat, lng, tz) {
  const year = dateObj.getFullYear();
  const month = dateObj.getMonth() + 1;
  const day = dateObj.getDate();
  const jd = julian(year, month, day) - lng / (15 * 24);

  function midDay() {
    const eqt = sunPosition(jd).equation;
    return fixHour(12 - eqt);
  }
  function sunAngleTime(angle, direction) {
    const decl = sunPosition(jd).declination;
    const noon = midDay();
    const t = (1 / 15) * darccos((-dsin(angle) - dsin(decl) * dsin(lat)) / (dcos(decl) * dcos(lat)));
    return noon + (direction === 'ccw' ? -t : t);
  }
  function asrTime(factor) {
    const decl = sunPosition(jd).declination;
    const angle = -darccot(factor + dtan(Math.abs(lat - decl)));
    return sunAngleTime(angle, 'cw'); // العصر بعد الزوال
  }

  const dhuhr = midDay();
  const sunrise = sunAngleTime(0.833, 'ccw');
  const fajr = sunAngleTime(18.5, 'ccw');           // أم القرى
  const asr = asrTime(1);                           // المذهب الشافعي (المعتمد)
  const maghrib = sunAngleTime(0.833, 'cw');
  const isha = maghrib + 1.5;                       // أم القرى: المغرب + 90 دقيقة

  const adjust = (h) => fixHour(h + tz - lng / 15);
  const fmt = (h) => {
    const hh = Math.floor(h);
    const mm = Math.floor((h - hh) * 60 + 0.5);
    return String(hh).padStart(2, '0') + ':' + String(mm % 60).padStart(2, '0');
  };

  return {
    fajr: fmt(adjust(fajr)),
    sunrise: fmt(adjust(sunrise)),
    dhuhr: fmt(adjust(dhuhr)),
    asr: fmt(adjust(asr)),
    maghrib: fmt(adjust(maghrib)),
    isha: fmt(adjust(isha)),
  };
}

/* ---------- أدوات استجابة ---------- */
function sendJSON(res, code, obj) {
  try {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
  } catch {}
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > (limit || 2_000_000)) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function parseBody(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}
function getToken(req) {
  const auth = req.headers['authorization'] || '';
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const x = req.headers['x-auth-token'];
  if (x) return String(x).trim();
  const cookie = req.headers['cookie'] || '';
  const m = cookie.match(/hiwar_token=([^;\s]+)/);
  return m ? m[1] : null;
}
function authUser(req) {
  const t = getToken(req);
  if (!t || !sessions[t]) return null;
  const userId = sessions[t].userId;
  const u = users[userId];
  return u ? { userId, user: u } : null;
}

/* ---------- معالجة الطلبات ---------- */
async function handle(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  /* --- تسجيل حساب جديد --- */
  if (p === '/api/auth/register' && m === 'POST') {
    const body = parseBody(await readBody(req));
    if (!body) return sendJSON(res, 400, { error: 'Invalid JSON' }), true;
    const name = String(body.name || '').trim().slice(0, 80);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 120);
    const phone = String(body.phone || '').trim().slice(0, 30);
    const password = String(body.password || '');
    if (!name) return sendJSON(res, 400, { error: 'الاسم مطلوب' }), true;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJSON(res, 400, { error: 'بريد إلكتروني غير صالح' }), true;
    if (password.length < 6) return sendJSON(res, 400, { error: 'كلمة المرور 6 أحرف على الأقل' }), true;

    for (const id in users) if (users[id].email === email) return sendJSON(res, 409, { error: 'هذا البريد مسجّل مسبقاً — سجّلي الدخول' }), true;

    const id = uid();
    const salt = makeSalt();
    users[id] = {
      id, name, email, phone, salt,
      passHash: hashPassword(password, salt),
      createdAt: new Date().toISOString(),
    };
    saveJSON(USERS_FILE, users);

    const token = makeToken();
    sessions[token] = { userId: id, createdAt: Date.now() };
    saveJSON(SESSIONS_FILE, sessions);

    return sendJSON(res, 200, { token, user: publicUser(users[id]) }), true;
  }

  /* --- تسجيل الدخول --- */
  if (p === '/api/auth/login' && m === 'POST') {
    const body = parseBody(await readBody(req));
    if (!body) return sendJSON(res, 400, { error: 'Invalid JSON' }), true;
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    let found = null;
    for (const id in users) if (users[id].email === email) { found = users[id]; break; }
    if (!found) return sendJSON(res, 401, { error: 'البريد أو كلمة المرور غير صحيحة' }), true;
    const h = hashPassword(password, found.salt);
    if (h !== found.passHash) return sendJSON(res, 401, { error: 'البريد أو كلمة المرور غير صحيحة' }), true;

    const token = makeToken();
    sessions[token] = { userId: found.id, createdAt: Date.now() };
    saveJSON(SESSIONS_FILE, sessions);
    return sendJSON(res, 200, { token, user: publicUser(found) }), true;
  }

  /* --- تسجيل الخروج --- */
  if (p === '/api/auth/logout' && m === 'POST') {
    const t = getToken(req);
    if (t) { delete sessions[t]; saveJSON(SESSIONS_FILE, sessions); }
    return sendJSON(res, 200, { ok: true }), true;
  }

  /* --- بيانات المستخدم الحالي --- */
  if (p === '/api/auth/me' && m === 'GET') {
    const a = authUser(req);
    if (!a) return sendJSON(res, 401, { error: 'غير مسجّل الدخول' }), true;
    return sendJSON(res, 200, { user: publicUser(a.user), profile: profiles[a.userId] || null }), true;
  }

  /* --- الملف الشخصي: قراءة/حفظ (مزامنة عبر الأجهزة) --- */
  if (p === '/api/profile') {
    const a = authUser(req);
    if (!a) return sendJSON(res, 401, { error: 'غير مسجّل الدخول' }), true;
    if (m === 'GET') {
      return sendJSON(res, 200, { profile: profiles[a.userId] || null }), true;
    }
    if (m === 'POST') {
      const body = parseBody(await readBody(req, 4_000_000));
      if (!body || typeof body.profile !== 'object' || Array.isArray(body.profile)) {
        return sendJSON(res, 400, { error: 'ملف غير صالح' }), true;
      }
      // حدود أمان على الحجم
      const str = JSON.stringify(body.profile);
      if (str.length > 1_500_000) return sendJSON(res, 400, { error: 'الملف كبير جداً' }), true;
      profiles[a.userId] = { ...body.profile, updatedAt: new Date().toISOString() };
      saveJSON(PROFILES_FILE, profiles);
      return sendJSON(res, 200, { ok: true }), true;
    }
  }

  /* --- مواقيت الصلاة --- */
  if (p === '/api/prayer-times' && m === 'GET') {
    const cityInput = String(url.searchParams.get('city') || '').trim();
    const dateStr = String(url.searchParams.get('date') || '');
    let dateObj = new Date();
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const [y, mo, d] = dateStr.split('-').map(Number);
      dateObj = new Date(y, mo - 1, d);
    }
    const city = findCity(cityInput) || { name: cityInput || 'مكة المكرمة', lat: 21.3891, lng: 39.8579 };
    const times = computePrayerTimes(dateObj, city.lat, city.lng, 3); // توقيت السعودية UTC+3
    return sendJSON(res, 200, {
      city: city.name,
      date: dateObj.getFullYear() + '-' + String(dateObj.getMonth() + 1).padStart(2, '0') + '-' + String(dateObj.getDate()).padStart(2, '0'),
      times,
    }), true;
  }

  return false;
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, phone: u.phone || '', createdAt: u.createdAt };
}



  return { handle };
})();

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
