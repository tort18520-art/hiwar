/* ============================================================
   Hiwar (حوار) — وحدة الرفيقة الذكية (حسابات + ملف شخصي + مواقيت صلاة)
   ------------------------------------------------------------
   - حسابات مستخدمين (تسجيل/دخول/خروج) بتشفير كلمة المرور (scrypt)
   - ملف شخصي لكل طالبة يُحفظ على الخادم ويُزامَن عبر الأجهزة
   - حساب مواقيت الصلاة (طريقة أم القرى) لمدن سعودية + مدن مخصصة
   - تخزين JSON محلي بدون أي مكتبات خارجية
   ============================================================ */
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

module.exports = { handle };
