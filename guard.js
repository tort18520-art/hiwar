/* ============================================================
   Hiwar (حوار) — الحارس الذاتي (Self-Healing Supervisor)
   ------------------------------------------------------------
   يشغّل الخادم ويراقبه:
   1) إذا انهار الخادم لأي سبب → يعيد تشغيله فوراً (مع مهلة تصاعدية)
   2) إذا توقّف عن الاستجابة (فحص صحة كل 10 ثوانٍ) → يقتله ويعيد تشغيله
   3) يكتب كل الأحداث إلى logs/guard.log
   4) لا يموت هو نفسه أبداً (يحجز أخطائه الداخلية)

   التشغيل:  node guard.js
   خيارات بيئة: PORT, CHECK_INTERVAL (ms)
   ============================================================ */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL || 10000); // ms
const HEALTH_PATH = '/api/health';
const GRACE_MS = 8000;      // مهلة قبل بدء فحص صحة العميل الجديد
const FAIL_LIMIT = 3;        // عدد فشل الفحص المتتالي قبل القتل
const LOG_DIR = path.join(__dirname, 'logs');

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
const logStream = fs.createWriteStream(path.join(LOG_DIR, 'guard.log'), { flags: 'a' });

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  try { console.log(line); } catch {}
  try { logStream.write(line + '\n'); } catch {}
}

let child = null;
let stopping = false;
let restartCount = 0;
let lastRestartAt = 0;
let childStartAt = 0;
let failStreak = 0;
let totalRestarts = 0;

function healthCheck() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: HEALTH_PATH, timeout: 4000 },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode === 200));
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function startChild() {
  log(`▶ بدء تشغيل الخادم (المحاولة ${restartCount + 1})…`);
  childStartAt = Date.now();
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => logStream.write(d));
  child.stderr.on('data', (d) => logStream.write(d));
  child.on('exit', (code, signal) => {
    log(`✖ توقّف الخادم (code=${code}, signal=${signal})`);
    if (stopping) return;
    scheduleRestart();
  });
  child.on('error', (e) => {
    log('✖ فشل تشغيل الخادم:', (e && e.message) || e);
    if (!stopping) scheduleRestart();
  });
}

function scheduleRestart() {
  const now = Date.now();
  // إذا كان الخادم مستقراً لفترة طويلة، أعد العدّاد
  if (now - lastRestartAt > 60000) restartCount = 0;
  const delay = Math.min(1000 * Math.pow(2, restartCount), 30000);
  restartCount++;
  lastRestartAt = now;
  totalRestarts++;
  log(`⟳ إعادة التشغيل خلال ${delay / 1000} ثانية`);
  setTimeout(() => { if (!stopping) startChild(); }, delay);
}

async function monitor() {
  if (stopping || !child) return;
  // مهلة سماح حتى يكتمل إقلاع الخادم
  if (Date.now() - childStartAt < GRACE_MS) return;

  const ok = await healthCheck();
  if (ok) {
    if (failStreak) log(`✔ عاد الخادم للاستجابة`);
    failStreak = 0;
    return;
  }
  failStreak++;
  log(`⚠ فحص الصحة فشل (${failStreak}/${FAIL_LIMIT})`);
  if (failStreak >= FAIL_LIMIT) {
    log('⛔ الخادم لا يستجيب — قتله وإعادة تشغيله');
    failStreak = 0;
    try { child.kill('SIGKILL'); } catch {}
  }
}

// الحارس يحمي نفسه أيضاً
process.on('uncaughtException', (e) => log('guard uncaughtException:', (e && e.message) || e));
process.on('unhandledRejection', (e) => log('guard unhandledRejection:', (e && e.message) || e));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
function shutdown() {
  stopping = true;
  log('إيقاف الحارس…');
  if (child) { try { child.kill(); } catch {} }
  setTimeout(() => process.exit(0), 800);
}

startChild();
setInterval(monitor, CHECK_INTERVAL);
log(`🛡️ الحارس يعمل — يراقب الخادم على المنفذ ${PORT} (فحص كل ${CHECK_INTERVAL / 1000} ثانية)`);
