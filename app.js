/* ============================================================
   Hiwar (حوار) — رفيقة ذكية لطالبات المرحلة الثانوية
   ============================================================ */
'use strict';

/* ---------- أدوات ---------- */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const safeJSON = (s, f) => { try { const v = JSON.parse(s); return v == null ? f : v; } catch { return f; } };
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const C = window.Companion;

/* ---------- الحالة ---------- */
let token = localStorage.getItem('hiwar.token') || null;
let user = null;
let profile = null;
let prayers = null;
let prayersCity = null;
let history = [];       // سجل المحادثة الحالي
let streaming = false;
let flow = null;        // { steps, i, onDone, expectsText }
let voiceChatMode = false;
let listening = false;
let rec = null;
let speakGen = 0;
const audioEl = new Audio();
const firedReminders = {};
let reminderTimer = null;

// متغيرات تدفق مؤقتة
let habitName = '', habitFreq = '';
let taskSubject = '', taskType = '', taskKind = '', taskDue = '';
let courseName = '', courseDays = '';
let evTitle = '', evDate = '', evTime = '';

/* ---------- i18n مصغّر ---------- */
const T = {
  ar: { serverDown: 'تعذّر الاتصال بالخادم — تحقّقي من الإنترنت وحاولي مجدداً.', keyMissing: 'يرجى إضافة مفتاح API من الإعدادات ⚙️' },
  en: { serverDown: 'Could not reach the server — check your connection.', keyMissing: 'Please add an API key in Settings ⚙️' },
};
function t(k) { return (T[profile && profile.prefs && profile.prefs.lang === 'en' ? 'en' : 'ar'] || T.ar)[k] || k; }

function friendlyError(msg) {
  const s = String(msg || '').toLowerCase();
  if (/server_down|failed to fetch|networkerror|network/.test(s)) return t('serverDown');
  if (/key_missing/.test(s)) return t('keyMissing');
  if (/quota|429|rate.?limit/.test(s)) return 'الحصة المجانية ممتلئة مؤقتاً — حاولي بعد قليل أو بدّلي النموذج من الإعدادات ⚙️';
  if (/401|403|invalid api|مفتاح/.test(s)) return 'مفتاح الذكاء الاصطناعي غير صحيح — تحقّقي من الإعدادات ⚙️';
  return String(msg || 'حدث خطأ غير متوقع.');
}

/* ---------- Toast ---------- */
function toast(msg, ms) {
  const wrap = $('#toastWrap');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, ms || 3400);
}

/* ---------- Markdown مصغّر ---------- */
function md(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  const parts = s.split(/\n{2,}/).map((p) => {
    p = p.trim();
    if (!p) return '';
    if (/^<(h\d|ul|ol|pre|blockquote)/.test(p)) return p;
    if (p.split('\n').every((l) => /^[-•*] /.test(l) || /^\d+\. /.test(l))) {
      const items = p.split('\n').map((l) => '<li>' + l.replace(/^[-•*] /, '').replace(/^\d+\. /, '') + '</li>').join('');
      return '<ul>' + items + '</ul>';
    }
    return '<p>' + p + '</p>';
  });
  return parts.join('').replace(/\n/g, '<br>');
}

/* ---------- رسائل ---------- */
function scroll() { const m = $('#messages'); if (m) m.scrollTop = m.scrollHeight; }
function addMsg(role, html, opts) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (role === 'user' ? 'user' : 'ai');
  const col = document.createElement('div');
  col.className = 'msg-col';
  const b = document.createElement('div');
  b.className = 'bubble';
  b.innerHTML = html;
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = (opts && opts.time) ? opts.time : '';
  col.appendChild(b); col.appendChild(meta); wrap.appendChild(col);
  $('#messages').appendChild(wrap);
  scroll();
  return b;
}
function nowTime() { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
function assistantSay(text, opts) {
  opts = opts || {};
  const b = addMsg('ai', md(text), { time: nowTime() });
  history.push({ role: 'assistant', content: text });
  renderQuickChips(opts.chips);
  if (opts.speak && profile && profile.prefs.voice) speak(text);
  return b;
}
function assistantNote(text) { addMsg('ai', md(text), { time: nowTime() }); history.push({ role: 'assistant', content: text }); }
function userSay(text) {
  addMsg('user', md(text), { time: nowTime() });
  history.push({ role: 'user', content: text });
}

/* ---------- الاختيارات السريعة ---------- */
function renderQuickChips(chips) {
  const bar = $('#quickBar'), cont = $('#quickChips');
  if (!bar || !cont) return;
  cont.innerHTML = '';
  if (!chips || !chips.length) { bar.hidden = true; return; }
  for (const c of chips) {
    const b = document.createElement('button');
    b.className = 'qchip';
    b.textContent = c.label;
    b.addEventListener('click', () => { if (flow) answerFlow(c.value); else toast('اختيار منتهي'); });
    cont.appendChild(b);
  }
  bar.hidden = false;
}
function clearQuickChips() { const bar = $('#quickBar'); if (bar) bar.hidden = true; }

/* ---------- محرك التدفق ---------- */
function startFlow(steps, onDone) {
  flow = { steps: steps || [], i: 0, onDone: onDone || null, expectsText: false };
  nextFlowStep();
}
function nextFlowStep() {
  if (!flow) return;
  clearQuickChips();
  if (flow.i >= flow.steps.length) { const d = flow.onDone; flow = null; if (d) d(); return; }
  const s = flow.steps[flow.i];
  let r;
  try { r = s.render(profile); } catch (e) { r = null; }
  if (!r || !r.text) { flow.i++; nextFlowStep(); return; }
  flow.expectsText = !!r.expectsText;
  const text = r.advice ? (r.text + '\n\n💡 *نصيحة: ' + r.advice + '*') : r.text;
  assistantSay(text, { chips: r.chips, speak: !!profile.prefs.voice && !r.expectsText });
  // خطوة إعلامية بلا أزرار ولا إدخال → تتقدم تلقائياً
  if ((!r.chips || !r.chips.length) && !r.expectsText) {
    const tok = flow.i;
    setTimeout(() => { if (flow && flow.i === tok) { flow.i++; nextFlowStep(); } }, 800);
  }
}
function answerFlow(value) {
  if (!flow) return;
  const s = flow.steps[flow.i];
  const extra = [];
  try { if (s.apply) s.apply(value, profile, extra); } catch (e) { console.error(e); }
  flow.steps.splice(flow.i + 1, 0, ...extra);
  flow.i++;
  nextFlowStep();
}

/* ---------- API ---------- */
async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = safeJSON(await res.text().catch(() => ''), {});
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}
async function fetchPrayers(city, date) {
  try {
    const q = new URLSearchParams({ city: city || 'الخبر', date: date || C.todayStr() });
    const res = await fetch('/api/prayer-times?' + q.toString());
    if (res.ok) return (await res.json()).times || null;
  } catch {}
  return null;
}
async function ensurePrayers() {
  if (!profile) return null;
  if (!prayers || prayersCity !== profile.city) {
    prayers = await fetchPrayers(profile.city || 'الخبر', C.todayStr());
    prayersCity = profile.city || 'الخبر';
  }
  return prayers;
}
function saveProfile() {
  if (!token) return;
  profile.updatedAt = new Date().toISOString();
  api('POST', '/api/profile', { profile }).catch((e) => toast('تعذّر حفظ الملف: ' + friendlyError(e.message)));
}

/* ---------- الشاشات ---------- */
function showScreen(name) {
  for (const id of ['landing', 'authScreen', 'chat']) { const el = $('#' + id); if (el) el.hidden = (id !== name); }
}
function goAuth() { setAuthTab('login'); showScreen('authScreen'); }
function goChat() { showScreen('chat'); }

/* ---------- المصادقة ---------- */
function bindAuth() {
  $('#tabLogin').addEventListener('click', () => setAuthTab('login'));
  $('#tabRegister').addEventListener('click', () => setAuthTab('register'));
  $('#authBackBtn').addEventListener('click', () => showScreen('landing'));
  $('#loginForm').addEventListener('submit', (e) => { e.preventDefault(); doLogin(); });
  $('#registerForm').addEventListener('submit', (e) => { e.preventDefault(); doRegister(); });
}
function setAuthTab(which) {
  $('#tabLogin').classList.toggle('active', which === 'login');
  $('#tabRegister').classList.toggle('active', which === 'register');
  $('#loginForm').hidden = which !== 'login';
  $('#registerForm').hidden = which !== 'register';
  authError('');
}
function authError(msg) { const el = $('#authError'); el.textContent = msg; el.hidden = !msg; }
async function doRegister() {
  authError('');
  try {
    const r = await api('POST', '/api/auth/register', {
      name: $('#regName').value.trim(), email: $('#regEmail').value.trim(),
      phone: $('#regPhone').value.trim(), password: $('#regPassword').value,
    });
    onAuthed(r);
  } catch (e) { authError(friendlyError(e.message)); }
}
async function doLogin() {
  authError('');
  try {
    const r = await api('POST', '/api/auth/login', { email: $('#loginEmail').value.trim(), password: $('#loginPassword').value });
    onAuthed(r);
  } catch (e) { authError(friendlyError(e.message)); }
}
async function onAuthed(r) {
  token = r.token; user = r.user;
  localStorage.setItem('hiwar.token', token);
  profile = C.defaultProfile();
  try {
    const me = await api('GET', '/api/auth/me');
    if (me.profile) profile = Object.assign(profile, me.profile);
  } catch {}
  enterApp();
}
async function logout() {
  try { await api('POST', '/api/auth/logout'); } catch {}
  token = null; user = null; profile = null;
  localStorage.removeItem('hiwar.token');
  stopSpeaking(); stopReminders();
  showScreen('landing');
}

/* ---------- دخول التطبيق ---------- */
async function enterApp() {
  goChat();
  $('#chatTitle').textContent = user.name;
  $('#messages').innerHTML = '';
  history = [];
  if (profile.city) prayers = await fetchPrayers(profile.city, C.todayStr());
  renderPanel();
  startReminders();
  const today = C.todayStr();
  if (!profile.onboardingDone) {
    startFlow(onboardingSteps(), async () => { profile.onboardingDone = true; saveProfile(); await ensurePrayers(); startFlow(dailySteps(), afterDaily); });
  } else if (profile.lastDaily !== today) {
    assistantSay('أهلاً بعودتك يا ' + user.name + ' 🌸 جاهزة ننظم يومك؟', { chips: [{ label: 'نعم، لنبدأ', value: '__go' }, { label: 'لاحقاً', value: '__later' }], speak: true });
    flow = { steps: [{ render: () => ({ text: '', chips: [] }), apply: (v, p, ex) => { if (v === '__go') ex.push(...dailySteps()); } }], i: 0, expectsText: false, onDone: null };
  } else {
    const sug = C.suggestions(profile);
    const txt = 'أهلاً بكِ يا ' + user.name + ' 🌸\n' + (sug.length ? '💡 ' + sug[0] + '\n\nماذا تريدين أن تفعلي اليوم؟' : 'ماذا تريدين أن تفعلي اليوم؟');
    assistantSay(txt, { chips: [{ label: '📅 جدول اليوم', value: '__schedule' }, { label: '➕ إضافة مهمة', value: '__addtask' }, { label: '💡 فكرة مشروع', value: '__idea' }, { label: '🔔 تفعيل الإشعارات', value: '__notif' }, { label: '🔁 إعادة أسئلة اليوم', value: '__daily' }], speak: true });
    flow = { steps: [{ render: () => ({ text: '', chips: [] }), apply: (v, p, ex) => {
      if (v === '__schedule') openSchedule();
      else if (v === '__addtask') startFlow(addTaskFlow(), afterDaily);
      else if (v === '__idea') startFlow(projectIdeaFlow(), () => {});
      else if (v === '__notif') requestNotifications();
      else if (v === '__daily') startFlow(dailySteps(), afterDaily);
    } }], i: 0, expectsText: false, onDone: null };
  }
}
function afterDaily() { profile.lastDaily = C.todayStr(); saveProfile(); renderPanel(); refreshScheduleIfOpen(); scheduleNotifications(); }

/* ============================================================
   التدفقات (onboarding + يومي + إضافة مهمة + عادات + دورات + مناسبات)
   ============================================================ */
function opt(label, value) { return { label, value }; }

function onboardingSteps() {
  const S = [];
  S.push({ render: () => ({ text: 'أهلاً وسهلاً بكِ في «حوار» 🌸\nأنا رفيقتك الذكية — سأساعدك على تنظيم دراستك وواجباتك وعاداتك ويومك كاملاً.\n\nأولاً: في أي مدينة تسكنين؟ (لأضيف لكِ مواقيت الصلاة بدقة)', chips: [opt('الخبر', 'الخبر'), opt('الدمام', 'الدمام'), opt('الظهران', 'الظهران'), opt('القطيف', 'القطيف'), opt('الجبيل', 'الجبيل'), opt('الرياض', 'الرياض'), opt('جدة', 'جدة')] }),
    apply: (v, p, ex) => { p.city = v; ex.push({ render: () => ({ text: 'تمام، سأعتمد مواقيت الصلاة لمدينة ' + v + ' 🕌', chips: [] }), apply: () => {} }); } });

  S.push({ render: () => ({ text: 'هل تدرسين في ' + C.HS8.school + '؟', chips: [opt('نعم — الثانوية الثامنة', 'hs8'), opt('مدرسة أخرى', 'other')] }),
    apply: (v, p, ex) => { p.school = v; if (v === 'hs8') { p.schoolName = C.HS8.school; p.schoolStart = C.HS8.start; p.schoolEnd = C.HS8.end; } } });

  S.push({ render: (p) => ({ text: p.school === 'other' ? 'ما اسم مدرستك؟ (اكتبي الاسم)' : 'ما رقم صفّك/شعبتك؟', chips: p.school === 'other' ? null : ['١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩', '١٠'].map((n) => opt(n, n)), expectsText: p.school === 'other' }),
    apply: (v, p) => { if (p.school === 'other') p.schoolName = v; else p.section = v; } });

  S.push({ render: () => ({ text: 'في أي صف أنتِ؟', chips: [opt('الأول الثانوي', 'first'), opt('الثاني الثانوي', 'second'), opt('الثالث الثانوي', 'third')] }),
    apply: (v, p) => { p.grade = v; p.subjects = (C.GRADE_INFO[v] && C.GRADE_INFO[v].subjects) ? C.GRADE_INFO[v].subjects.slice() : []; } });

  S.push({ render: (p) => (p.school === 'hs8' ? null : { text: 'متى يبدأ دوامك وينتهي؟ (اكتبي مثل: 7:00 إلى 1:00)', chips: null, expectsText: true }),
    apply: (v, p) => { if (p.school === 'hs8') return; const m = String(v).match(/(\d{1,2}):?(\d{2})?\s*(إلى|-|الى|حتى|و)\s*(\d{1,2}):?(\d{2})?/); if (m) { p.schoolStart = String(m[1]).padStart(2, '0') + ':' + (m[2] || '00'); p.schoolEnd = String(m[4]).padStart(2, '0') + ':' + (m[5] || '00'); } } });

  S.push({ render: () => ({ text: 'متى تنامين عادة في الليل؟', chips: [opt('9:00 مساءً', '21:00'), opt('9:30 مساءً', '21:30'), opt('10:00 مساءً', '22:00'), opt('11:00 مساءً', '23:00'), opt('منتصف الليل', '00:00')] }),
    apply: (v, p, ex) => { p.sleepTime = v; if (C.toMin(v) >= C.toMin('23:00')) { ex.push({ render: () => ({ text: '💡 النوم المبكر مهم جداً لتركيزك وذاكرتك. أنصحك بالنوم بين 9:00 و9:30 مساءً — هل تريدين ضبط نومك على 9:30؟', chips: [opt('نعم، 9:30', '21:30'), opt('أبقي وقتي الحالي', v)] }), apply: (v2, p2) => { p2.sleepTime = v2; } }); } } });

  S.push({ render: () => ({ text: 'هل تريدين وقتاً يومياً للعناية الشخصية؟', chips: [opt('نعم — بعد العشاء', 'afterIsha'), opt('نعم — قبل النوم', 'beforeSleep'), opt('لا', null)] }),
    apply: (v, p) => { p.personalCare = v; } });

  S.push({ render: () => ({ text: 'هل أضيف تذكيراً يومياً لتجهيز حقيبتك المدرسية؟ 🎒', chips: [opt('نعم', true), opt('لا', false)] }),
    apply: (v, p) => { p.bagReminder = !!v; } });

  // عادات
  S.push({ render: () => ({ text: 'ما العادات التي تريدين متابعتها؟ (اكتبي اسم العادة أو اختاري)', chips: [opt('قراءة القرآن', 'قراءة القرآن'), opt('مذاكرة يومية', 'مذاكرة يومية'), opt('الرياضة', 'الرياضة'), opt('لا شيء — تخطي', '__skip')], expectsText: true }),
    apply: (v, p, ex) => { if (v === '__skip') { ex.push(habitsDone()); return; } habitName = v; ex.push(habitFreqStep()); } });

  // دورات
  S.push({ render: () => ({ text: 'هل أنتِ مشتركة في دورات تدريبية؟', chips: [opt('نعم', '__yes'), opt('لا', '__no')] }),
    apply: (v, p, ex) => { if (v === '__yes') ex.push(courseNameStep()); } });

  // مناسبات
  S.push({ render: () => ({ text: 'هل لديكِ مناسبات اجتماعية اليوم أو هذا الأسبوع؟', chips: [opt('نعم', '__yes'), opt('لا', '__no')] }),
    apply: (v, p, ex) => { if (v === '__yes') ex.push(eventTitleStep()); } });

  S.push({ render: (p) => ({ text: 'رائع! اكتمل الإعداد 🎉\nالآن سأسألك عن مهامك الدراسية لأبني لكِ جدول اليوم.', chips: [opt('هيا بنا', '__go')] }), apply: () => {} });
  return S;
}

function habitNameStep() {
  return { render: () => ({ text: 'ما اسم العادة؟ (اكتبيها أو اختاري)', chips: [opt('قراءة القرآن', 'قراءة القرآن'), opt('مذاكرة يومية', 'مذاكرة يومية'), opt('الرياضة', 'الرياضة'), opt('كتابة يوميات', 'كتابة يوميات')], expectsText: true }),
    apply: (v, p, ex) => { habitName = v; ex.push(habitFreqStep()); } };
}
function habitFreqStep() {
  return { render: () => ({ text: 'كم مرة أتابع «' + habitName + '»؟', chips: [opt('يومياً', 'daily'), opt('أيام الدوام', 'weekdays'), opt('مرة بالأسبوع', 'weekly')] }),
    apply: (v, p, ex) => { habitFreq = v; ex.push(habitTimeStep()); } };
}
function habitTimeStep() {
  return { render: () => ({ text: 'متى تحبين أداء «' + habitName + '»؟', chips: [opt('صباحاً', '08:00'), opt('بعد العصر', '16:00'), opt('بعد المغرب', '18:30'), opt('قبل النوم', '21:00')] }),
    apply: (v, p, ex) => { p.habits.push({ id: uid(), name: habitName, frequency: habitFreq, time: v, durationMin: 15, streak: 0, best: 0, history: {} }); ex.push(habitAnotherStep()); } };
}
function habitAnotherStep() {
  return { render: () => ({ text: 'هل من عادة أخرى؟', chips: [opt('نعم', '__more'), opt('لا — اكتفيت', '__done')] }),
    apply: (v, p, ex) => { if (v === '__more') ex.push(habitNameStep()); } };
}
function habitsDone() { return { render: () => ({ text: 'حسناً، يمكنك إضافة العادات لاحقاً من لوحة التحكم 💛', chips: [] }), apply: () => {} }; }

function courseNameStep() {
  return { render: () => ({ text: 'ما اسم الدورة؟ (اكتبيها أو اختاري)', chips: [opt('دورة لغة إنجليزية', 'لغة إنجليزية'), opt('تحفيظ قرآن', 'تحفيظ قرآن'), opt('دورة حاسب', 'حاسب آلي')], expectsText: true }),
    apply: (v, p, ex) => { courseName = v; ex.push(courseDaysStep()); } };
}
function courseDaysStep() {
  return { render: () => ({ text: 'في أي أيام تكون دورة «' + courseName + '»؟', chips: [opt('أيام الأسبوع', 'weekdays'), opt('عطلة نهاية الأسبوع', 'weekend')] }),
    apply: (v, p, ex) => { courseDays = v; ex.push(courseTimeStep()); } };
}
function courseTimeStep() {
  return { render: () => ({ text: 'في أي ساعة؟ (اكتبي مثل 16:00 أو اختاري)', chips: [opt('بعد العصر (4:00)', '16:00'), opt('بعد المغرب (6:30)', '18:30')], expectsText: true }),
    apply: (v, p, ex) => { p.courses.push({ id: uid(), name: courseName, days: courseDays === 'weekend' ? [5, 6] : [0, 1, 2, 3, 4], time: normalizeTime(v) }); } };
}

function eventTitleStep() {
  return { render: () => ({ text: 'ما المناسبة؟ (اكتبيها أو اختاري)', chips: [opt('زيارة عائلية', 'زيارة عائلية'), opt('مناسبة/عزيمة', 'مناسبة عائلية')], expectsText: true }),
    apply: (v, p, ex) => { evTitle = v; ex.push(eventWhenStep()); } };
}
function eventWhenStep() {
  return { render: () => ({ text: 'متى تكون؟ (اليوم / غداً / أو اكتبي التاريخ مثل 15/9)', chips: [opt('اليوم', '__today'), opt('غداً', '__tomorrow')], expectsText: true }),
    apply: (v, p, ex) => { evDate = (v === '__today') ? C.todayStr() : (v === '__tomorrow') ? C.addDaysStr(C.todayStr(), 1) : guessDate(v); ex.push(eventTimeStep()); } };
}
function eventTimeStep() {
  return { render: () => ({ text: 'في أي ساعة؟ (اكتبي مثل 17:00 أو اختاري)', chips: [opt('بعد العصر (4:00)', '16:00'), opt('مساءً (7:00)', '19:00')], expectsText: true }),
    apply: (v, p, ex) => { evTime = normalizeTime(v); ex.push(eventFixedStep()); } };
}
function eventFixedStep() {
  return { render: () => ({ text: 'هل وقتها ثابت أم مرن؟', chips: [opt('ثابت', 'fixed'), opt('مرن', 'flex')] }),
    apply: (v, p, ex) => { p.events.push({ id: uid(), title: evTitle, date: evDate, time: evTime, fixed: v === 'fixed' }); ex.push(eventAnotherStep()); } };
}
function eventAnotherStep() {
  return { render: () => ({ text: 'هل من مناسبة أخرى؟', chips: [opt('نعم', '__more'), opt('لا', '__done')] }),
    apply: (v, p, ex) => { if (v === '__more') ex.push(eventTitleStep()); } };
}

function normalizeTime(v) {
  const s = String(v || '').trim();
  const m = s.match(/(\d{1,2}):?(\d{2})?/);
  if (m) return String(m[1]).padStart(2, '0') + ':' + (m[2] || '00');
  return '16:00';
}
function guessDate(v) {
  const s = String(v || '').trim();
  const m = s.match(/(\d{1,2})\s*[\/\-]\s*(\d{1,2})/);
  if (m) { const now = new Date(); return now.getFullYear() + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0'); }
  return C.todayStr();
}

/* ---------- التدفق اليومي ---------- */
function dailySteps() {
  const S = [];
  const subs = (profile.subjects && profile.subjects.length) ? profile.subjects : C.GRADE_INFO.first.subjects;
  S.push({ render: () => ({ text: 'سأسألك الآن عن كل مادة بإذن الله — أجيبي بسرعة من الأزرار 👇', chips: [opt('ابدئي', '__go')] }), apply: () => {} });
  const finalStep = () => ({
    render: (p) => {
      const today = C.todayStr();
      const items = C.buildSchedule(p, prayers, today);
      const summary = C.timelineSummary(items);
      return { text: 'تم تجهيز جدولك الذكي لليوم ✨\n\n' + summary + '\n\nاضغطي «عرض الجدول» لرؤيته منظماً.', chips: [opt('📅 عرض الجدول كاملاً', '__show'), opt('💡 نصيحة ذكية', '__advice'), opt('✨ فكرة مشروع', '__idea')] };
    },
    apply: (v, p, ex) => { if (v === '__show') openSchedule(); if (v === '__advice') aiAdvice(); if (v === '__idea') startFlow(projectIdeaFlow(), () => {}); },
  });
  const tailSteps = () => [
    { render: () => ({ text: 'انتهت المواد — الآن لنكمل بقية يومك 🌤️\nهل تريدين مراجعة خفيفة بعد صلاة الفجر قبل المدرسة؟', advice: 'المراجعة الصباحية بعد الفجر من أفضل أوقات الحفظ والتركيز.', chips: [opt('نعم، ربع ساعة', 'y15'), opt('نعم، نصف ساعة', 'y30'), opt('لا', 'no')] }),
      apply: (v, p) => { if (v !== 'no') p.tasks.push({ id: uid(), subject: '', type: 'other', kind: 'review', title: 'مراجعة صباحية', dueDate: C.todayStr(), durationMin: v === 'y15' ? 15 : 30, time: prayers && prayers.fajr ? C.fmtMin(C.toMin(prayers.fajr) + 5) : '05:30', done: false, createdAt: Date.now() }); } },
    { render: () => ({ text: 'بعد العودة من المدرسة — هل تحتاجين وقت راحة وقيلولة؟', advice: 'استراحة قصيرة بعد الدوام تجدد طاقتك للمذاكرة المسائية.', chips: [opt('نعم، ساعة راحة', 'y'), opt('نصف ساعة فقط', 'h'), opt('لا', 'no')] }),
      apply: (v, p) => { if (v !== 'no') p.tasks.push({ id: uid(), subject: '', type: 'other', kind: 'rest', title: 'راحة بعد المدرسة', dueDate: C.todayStr(), durationMin: v === 'y' ? 60 : 30, time: p.schoolEnd || '13:15', done: false, createdAt: Date.now() }); } },
    { render: () => ({ text: 'هل تخصصين وقتاً مسائياً للترفيه أو الجلوس مع العائلة؟', advice: 'وقت الأسرة والترفيه مهم لتوازنك النفسي — لا تهمليه.', chips: [opt('نعم، ساعة مساءً', 'y'), opt('نصف ساعة', 'h'), opt('لا', 'no')] }),
      apply: (v, p) => { if (v !== 'no') p.tasks.push({ id: uid(), subject: '', type: 'other', kind: 'fun', title: 'وقت ترفيهي/عائلي', dueDate: C.todayStr(), durationMin: v === 'y' ? 60 : 30, time: prayers && prayers.isha ? C.fmtMin(C.toMin(prayers.isha) + 15) : '19:30', done: false, createdAt: Date.now() }); } },
    { render: () => ({ text: 'قبل النوم — هل نضيف مراجعة سريعة لملخص اليوم (10 دقائق)؟', advice: 'تلخيص ما ذاكرته قبل النوم يثبّت المعلومة في الذاكرة.', chips: [opt('نعم', 'y'), opt('لا', 'no')] }),
      apply: (v, p) => { if (v === 'y') p.tasks.push({ id: uid(), subject: '', type: 'other', kind: 'review', title: 'مراجعة ملخص اليوم', dueDate: C.todayStr(), durationMin: 10, time: C.fmtMin(C.toMin(p.sleepTime || '21:30') - 25), done: false, createdAt: Date.now() }); } },
    ...habitsCheckSteps(),
    { render: () => ({ text: 'متى تحبين المذاكرة عادة؟', advice: 'المذاكرة بعد المغرب غالباً أهدأ وأكثر تركيزاً.', chips: [opt('بعد العصر', 'afterAsr'), opt('بعد المغرب', 'afterMaghrib'), opt('صباحاً', 'morning'), opt('أي وقت', 'any')] }),
      apply: (v, p) => { p.prefs.studyWindow = v; } },
    finalStep(),
  ];
  pushSubjectSteps(subs, 0, S, (ex) => { ex.push(...tailSteps()); });
  return S;
}

/* ---------- أفكار المشاريع ---------- */
function projectIdeaFlow() {
  const subs = (profile.subjects && profile.subjects.length) ? profile.subjects : C.GRADE_INFO.first.subjects;
  const S = [];
  S.push({ render: () => ({ text: 'يسعدني ذلك! 💡 لأي مادة تريدين فكرة مشروع؟', chips: subs.map((s) => opt(s, s)).concat([opt('أخرى — اكتبيها', '__other')]), expectsText: false }),
    apply: (v, p, ex) => {
      if (v === '__other') { ex.push({ render: () => ({ text: 'اكتبي اسم المادة ✍️', chips: null, expectsText: true }), apply: (v2, p2, ex2) => { showIdeas(v2); } }); return; }
      showIdeas(v);
    } });
  return S;
}
function showIdeas(subject) {
  let txt = C.formatIdeas(subject);
  assistantSay(txt, { speak: false });
  // محاولة إثراء بالذكاء الاصطناعي (اختياري، لا يمنع النجاح إن فشل)
  aiIdeas(subject).then((ai) => { if (ai) assistantSay(ai, { speak: false }); }).catch(() => {});
}
async function aiIdeas(subject) {
  try {
    const ctx = 'اقترحي فكرة مشروع مدرسي واحدة إضافية مميزة لمادة «' + subject + '» لطالبة ثانوية، مع 5 خطوات تنفيذ مرتبة ومواد مطلوبة. أسلوب لطيف ومشجع، أقل من 120 كلمة.';
    const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { provider: 'gemini', baseUrl: '', apiKey: '', model: profile && profile.model ? profile.model : 'gemini-flash-lite-latest' }, messages: [{ role: 'user', content: ctx }] }) });
    const full = await readSSE(res);
    return full ? '✨ فكرة إضافية من الذكاء الاصطناعي:\n\n' + full : null;
  } catch { return null; }
}

function pushSubjectSteps(subs, i, ex, cont) {
  if (i >= subs.length) { cont(ex); return; }
  const sub = subs[i];
  ex.push({
    render: () => ({ text: 'في مادة «' + sub + '» — ماذا لديكِ؟', chips: [opt('واجب', 'homework'), opt('مشروع', 'project'), opt('اختبار قريب', 'exam'), opt('لا شيء', 'none'), opt('أنهي الأسئلة', '__end')] }),
    apply: (v, p, ex2) => {
      if (v === '__end') { cont(ex2); return; }
      if (v === 'none') { pushSubjectSteps(subs, i + 1, ex2, cont); return; }
      taskSubject = sub; taskType = v; taskKind = ''; taskDue = C.todayStr();
      ex2.push(...taskDetailSteps((exNow) => pushSubjectSteps(subs, i + 1, exNow, cont)));
    },
  });
}

function taskDetailSteps(cont) {
  const today = C.todayStr();
  const S = [];
  if (taskType === 'homework') {
    S.push({ render: () => ({ text: 'واجب «' + taskSubject + '» — متى تسليمه؟', chips: [opt('اليوم', '__today'), opt('غداً', '__tomorrow')] }),
      apply: (v, p, ex) => { taskDue = v === '__today' ? today : C.addDaysStr(today, 1); ex.push(durationStep('كم يستغرق الواجب؟', cont)); } });
  } else if (taskType === 'project') {
    S.push({ render: () => ({ text: 'مشروع «' + taskSubject + '» — ما نوعه؟', chips: [opt('بحث', 'بحث'), opt('عرض تقديمي', 'عرض تقديمي'), opt('تجربة', 'تجربة')] }),
      apply: (v, p, ex) => { taskKind = v; ex.push({ render: () => ({ text: 'آخر موعد للمشروع؟', chips: [opt('بعد يومين', '2'), opt('نهاية الأسبوع', '4'), opt('الأسبوع القادم', '7')] }), apply: (v2, p2, ex2) => { taskDue = C.addDaysStr(today, Number(v2)); ex2.push(durationStep('كم وقت العمل عليه اليوم؟', cont)); } }); } });
  } else {
    S.push({ render: () => ({ text: 'اختبار «' + taskSubject + '» — قصير أم رئيسي؟', chips: [opt('اختبار قصير', 'اختبار قصير'), opt('اختبار رئيسي', 'اختبار رئيسي')] }),
      apply: (v, p, ex) => { taskKind = v; ex.push({ render: () => ({ text: 'متى موعد الاختبار؟', chips: [opt('هذا الأسبوع', '3'), opt('الأسبوع القادم', '7'), opt('بعد أسبوعين', '14')] }), apply: (v2, p2, ex2) => { taskDue = C.addDaysStr(today, Number(v2)); ex2.push(durationStep('كم تريدين مراجعة اليوم؟', cont)); } }); } });
  }
  return S;
}
function durationStep(q, cont) {
  return { render: () => ({ text: q, chips: [opt('٣٠ دقيقة', '30'), opt('ساعة', '60'), opt('ساعة ونصف', '90'), opt('أكثر', '120')] }),
    apply: (v, p, ex) => {
      const title = taskKind ? (taskSubject + ': ' + taskKind) : taskSubject;
      p.tasks.push({ id: uid(), subject: taskSubject, type: taskType, title, dueDate: taskDue, durationMin: Number(v), done: false, createdAt: Date.now() });
      if (cont) cont(ex);
    } };
}

function habitsCheckSteps() {
  const today = C.todayStr();
  const pending = (profile.habits || []).filter((h) => !C.habitDoneToday(h, today));
  if (!pending.length) return [];
  return pending.map((h) => ({
    render: () => ({ text: 'هل أكملتِ عادة «' + h.name + '» اليوم؟', chips: [opt('نعم ✅', 'yes'), opt('لا', 'no')] }),
    apply: (v, p) => { const r = C.checkHabit(p, h.id, v === 'yes', today); if (r.message) assistantNote(r.message); },
  }));
}

/* ---------- إضافة مهمة ---------- */
function addTaskFlow() {
  const today = C.todayStr();
  const S = [];
  S.push({ render: () => ({ text: 'ما اسم المهمة؟ (اكتبيها، مثل: بحث كيمياء)', chips: [opt('واجب رياضيات', 'الرياضيات'), opt('مشروع إنجليزي', 'اللغة الإنجليزية')], expectsText: true }),
    apply: (v, p, ex) => { taskKind = v; ex.push(addTypeStep()); } });
  S.push(addTypeStep());
  return S;
}
function addTypeStep() {
  return { render: () => ({ text: 'ما نوع المهمة «' + taskKind + '»؟', chips: [opt('واجب', 'homework'), opt('مشروع', 'project'), opt('اختبار', 'exam'), opt('أخرى', 'other')] }),
    apply: (v, p, ex) => { taskType = v; taskSubject = ''; ex.push(addDeadlineStep()); } };
}
function addDeadlineStep() {
  const today = C.todayStr();
  return { render: () => ({ text: 'متى آخر موعد لها؟', chips: [opt('اليوم', '__today'), opt('غداً', '__tomorrow'), opt('بعد يومين', '2'), opt('نهاية الأسبوع', '4'), opt('الأسبوع القادم', '7')] }),
    apply: (v, p, ex) => { taskDue = v === '__today' ? today : v === '__tomorrow' ? C.addDaysStr(today, 1) : C.addDaysStr(today, Number(v)); ex.push(durationStep('كم تستغرق؟', null)); } };
}

/* ---------- جدول اليوم ---------- */
async function openSchedule() {
  if (!profile) return;
  await ensurePrayers();
  $('#scheduleModal').hidden = false;
  renderSchedule();
}
function refreshScheduleIfOpen() { if (!$('#scheduleModal').hidden) renderSchedule(); }
function renderSchedule() {
  const today = C.todayStr();
  const items = C.buildSchedule(profile, prayers, today);
  $('#scheduleTitle').textContent = 'جدول ' + C.dayNameAr(today) + ' الذكي ✨';
  // مواقيت الصلاة
  const ps = $('#schedulePrayers');
  if (prayers) {
    const P = [['الفجر', prayers.fajr], ['الشروق', prayers.sunrise], ['الظهر', prayers.dhuhr], ['العصر', prayers.asr], ['المغرب', prayers.maghrib], ['العشاء', prayers.isha]];
    ps.innerHTML = P.map(([n, v]) => '<span class="prayer"><em>' + n + '</em><b>' + v + '</b></span>').join('');
  } else ps.innerHTML = '';
  const tl = $('#scheduleTimeline');
  tl.innerHTML = items.map((it) => {
    const cls = 'tl-item' + (it.fixed ? ' fixed' : '') + ' k-' + it.kind;
    return '<div class="' + cls + '"><span class="tl-time">' + it.start + '</span><span class="tl-ic">' + (it.icon || '•') + '</span><span class="tl-title">' + esc(it.title) + '</span></div>';
  }).join('') || '<p class="tl-empty">لا توجد عناصر اليوم — أضيفي مهمة من المحادثة 💬</p>';
}

/* ---------- لوحة التحكم ---------- */
function renderPanel() {
  const el = $('#panel');
  if (!el || !profile) return;
  const today = C.todayStr();
  const tasks = (profile.tasks || []).filter((t) => !t.done && t.dueDate && t.dueDate >= C.todayStr(-1)).slice(0, 8);
  const habits = profile.habits || [];
  el.innerHTML = `
    <div class="panel-user">
      <div class="panel-avatar">${esc((user.name || '؟').charAt(0))}</div>
      <div><b>${esc(user.name)}</b><span>${esc(profile.city || '')} · ${esc(profile.schoolName || '')}${profile.grade ? ' · ' + esc((C.GRADE_INFO[profile.grade] || {}).label || '') : ''}</span></div>
    </div>
    <div class="panel-sec">📅 ${C.dayNameAr(today)} ${today.slice(8, 10)}/${today.slice(5, 7)}</div>
    <div class="panel-sub">مهام قريبة</div>
    <div class="panel-tasks">${tasks.map((t) => `
      <div class="prow">
        <button class="pcheck" data-done="${t.id}" title="إنجاز">✓</button>
        <div class="pbody"><b>${esc(t.title)}</b><span>${esc(t.subject || '')} · ${t.dueDate === today ? 'اليوم' : C.fmtDateAr(t.dueDate)}</span></div>
        <button class="pdel" data-del="${t.id}" title="حذف">✕</button>
      </div>`).join('') || '<p class="pempty">لا مهام حالياً 🌸</p>'}</div>
    <div class="panel-sub">عاداتي</div>
    <div class="panel-tasks">${habits.map((h) => `
      <div class="prow">
        <button class="pcheck ${C.habitDoneToday(h, today) ? 'done' : ''}" data-habit="${h.id}" title="إنجاز اليوم">✓</button>
        <div class="pbody"><b>${esc(h.name)}</b><span>🔥 ${h.streak || 0} يوم متتالي</span></div>
        <button class="pdel" data-hdel="${h.id}" title="حذف">✕</button>
      </div>`).join('') || '<p class="pempty">لا عادات بعد — أضيفي من المحادثة</p>'}</div>
    <div class="panel-sub">🔔 تذكيرات اليوم</div>
    <div class="panel-tasks">${upcomingReminders().slice(0, 6).map((u) => `
      <div class="prow"><div class="pbody"><b>${esc(u.item.title)}</b><span>⏰ ${C.fmtMin(u.fireMin)}</span></div></div>`).join('') || '<p class="pempty">لا تذكيرات قادمة اليوم</p>'}</div>
    <div class="panel-actions">
      <button class="side-link" id="pNotif">🔔 تفعيل الإشعارات</button>
      <button class="side-link" id="pIdea">💡 فكرة مشروع</button>
      <button class="side-link" id="pAddTask">➕ إضافة مهمة</button>
      <button class="side-link" id="pRepeat">🔁 تكرار الجدول لغدٍ</button>
      <button class="side-link" id="pDaily">🔄 إعادة أسئلة اليوم</button>
      <button class="side-link" id="pOnboard">✏️ تعديل بياناتي</button>
      <button class="side-link danger" id="pLogout">🚪 تسجيل الخروج</button>
    </div>`;
  bindPanel();
}
function bindPanel() {
  const on = (id, fn) => { const el = $('#' + id); if (el) el.addEventListener('click', fn); };
  on('pAddTask', () => { closeSidebar(); startFlow(addTaskFlow(), afterDaily); });
  on('pRepeat', () => { repeatTomorrow(); closeSidebar(); });
  on('pDaily', () => { closeSidebar(); startFlow(dailySteps(), afterDaily); });
  on('pIdea', () => { closeSidebar(); startFlow(projectIdeaFlow(), () => {}); });
  on('pNotif', () => { closeSidebar(); requestNotifications(); });
  on('pOnboard', () => { closeSidebar(); startFlow(onboardingSteps(), () => { profile.onboardingDone = true; saveProfile(); }); });
  on('pLogout', logout);
  $$('#panel [data-done]').forEach((b) => b.addEventListener('click', () => {
    const t = profile.tasks.find((x) => x.id === b.dataset.done);
    if (t) { t.done = !t.done; if (t.done) { profile.stats.done = (profile.stats.done || 0) + 1; const h = new Date().getHours(); profile.stats.byHour = profile.stats.byHour || {}; profile.stats.byHour[h] = (profile.stats.byHour[h] || 0) + 1; } saveProfile(); renderPanel(); refreshScheduleIfOpen(); toast(t.done ? 'أحسنتِ! مهمة منجزة ✅' : 'أُعيدت المهمة للقائمة'); }
  }));
  $$('#panel [data-del]').forEach((b) => b.addEventListener('click', () => {
    profile.tasks = profile.tasks.filter((x) => x.id !== b.dataset.del);
    saveProfile(); renderPanel(); refreshScheduleIfOpen();
  }));
  $$('#panel [data-habit]').forEach((b) => b.addEventListener('click', () => {
    const today = C.todayStr();
    const h = profile.habits.find((x) => x.id === b.dataset.habit);
    if (h) { const done = !C.habitDoneToday(h, today); const r = C.checkHabit(profile, h.id, done, today); toast(r.message); saveProfile(); renderPanel(); }
  }));
  $$('#panel [data-hdel]').forEach((b) => b.addEventListener('click', () => {
    profile.habits = profile.habits.filter((x) => x.id !== b.dataset.hdel);
    saveProfile(); renderPanel();
  }));
}
function repeatTomorrow() {
  const today = C.todayStr(), tomorrow = C.addDaysStr(today, 1);
  let n = 0;
  for (const t of profile.tasks) if (!t.done && t.dueDate && t.dueDate <= today) { t.dueDate = tomorrow; n++; }
  saveProfile(); renderPanel(); refreshScheduleIfOpen();
  assistantSay(n ? 'كررتُ ' + n + ' مهمة ليوم غدٍ 🔁' : 'لا توجد مهام مكررة اليوم.', { speak: false });
}

/* ---------- نصيحة ذكية ---------- */
async function aiAdvice() {
  const b = assistantSay('أجهّز لكِ نصيحة شخصية… ✨', { speak: false });
  try {
    const sug = C.suggestions(profile);
    const today = C.todayStr();
    const items = C.buildSchedule(profile, prayers, today);
    const ctx = 'أنتِ رفيقة ذكية لطالبة ثانوية. قدّمي نصيحة عملية واحدة قصيرة (سطرين) لتحسين يومها بناء على: ' + JSON.stringify({ suggestions: sug, schedule: items.slice(0, 12).map((i) => i.title) });
    const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { provider: 'gemini', baseUrl: '', apiKey: '', model: 'gemini-flash-lite-latest' }, messages: [{ role: 'user', content: ctx }] }) });
    const full = await readSSE(res);
    b.innerHTML = md(full || ('💡 ' + (sug[0] || 'حافظي على توازنك بين المذاكرة والراحة والصلاة، وتقدمي خطوة بخطوة.')));
    if (profile.prefs.voice) speak(b.textContent);
  } catch (e) {
    const sug = C.suggestions(profile);
    b.innerHTML = md('💡 ' + (sug[0] || 'حافظي على توازنك بين المذاكرة والراحة والصلاة، وتقدمي خطوة بخطوة.'));
  }
}
async function readSSE(res) {
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '', full = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim(); if (d === '[DONE]') continue;
      let o; try { o = JSON.parse(d); } catch { continue; }
      if (o.t) full += o.t;
    }
  }
  return full.trim();
}

/* ---------- أوامر نصية ---------- */
function handleCommand(cmd) {
  if (!cmd || !cmd.action) return false;
  const today = C.todayStr();
  if (cmd.action === 'today') { openSchedule(); return true; }
  if (cmd.action === 'repeat') { repeatTomorrow(); return true; }
  if (cmd.action === 'delete') {
    const q = cmd.text.toLowerCase();
    const idx = profile.tasks.findIndex((t) => t.title.toLowerCase().includes(q));
    if (idx >= 0) { const t = profile.tasks[idx]; profile.tasks.splice(idx, 1); saveProfile(); renderPanel(); refreshScheduleIfOpen(); assistantSay('حذفتُ المهمة «' + t.title + '» 🗑️'); }
    else assistantSay('لم أجد مهمة بهذا الاسم. جرّبي من لوحة التحكم 📋');
    return true;
  }
  if (cmd.action === 'move') {
    const q = cmd.text.toLowerCase();
    const t = profile.tasks.find((x) => x.title.toLowerCase().includes(q));
    if (!t) { assistantSay('لم أجد المهمة المطلوبة.'); return true; }
    const anchor = /مغرب/.test(cmd.to) && prayers ? prayers.maghrib : /عصر/.test(cmd.to) && prayers ? prayers.asr : /فجر|صباح/.test(cmd.to) && prayers ? prayers.fajr : null;
    if (anchor) { t.time = anchor; assistantSay('نقلتُ «' + t.title + '» إلى بعد ' + cmd.to + ' ✅'); }
    else assistantSay('حسناً، سأضعها في أقرب فراغ مناسب ✅');
    saveProfile(); refreshScheduleIfOpen();
    return true;
  }
  if (cmd.action === 'add') { startFlow(addTaskFlow(), afterDaily); return true; }
  if (cmd.action === 'idea') { startFlow(projectIdeaFlow(), () => {}); return true; }
  return false;
}

/* ---------- المحادثة الذكية ---------- */
function systemContext() {
  if (!profile) return 'أنتِ «حوار»، رفيقة ذكية داعمة لطالبة ثانوية.';
  const today = C.todayStr();
  const tasks = (profile.tasks || []).filter((t) => !t.done).slice(0, 6).map((t) => `${t.title} (${t.type}, تسليم ${t.dueDate || '؟'}, ${t.durationMin} دقيقة)`).join('؛ ') || 'لا مهام مسجلة';
  const habits = (profile.habits || []).map((h) => h.name).join('، ') || 'لا عادات';
  const pr = prayers ? `${prayers.fajr}/${prayers.dhuhr}/${prayers.asr}/${prayers.maghrib}/${prayers.isha}` : 'غير متوفرة';
  return `أنتِ «حوار»، رفيقة ذكية ودودة ومشجّعة لطالبات المرحلة الثانوية (بنات) في السعودية. تحدّثي بالعربية الفصحى الواضحة بأسلوب لطيف ومحترم ومتوافق مع الثقافة الإسلامية، واجتهدي في تنظيم دراستها وحياتها. كوني موجزة وعملية (يفضل أقل من 80 كلمة ما لم يُطلب التفصيل).\nبيانات الطالبة: الاسم ${user ? user.name : ''}، المدينة ${profile.city || '؟'}، المدرسة ${profile.schoolName || '؟'}، الصف ${(C.GRADE_INFO[profile.grade] || {}).label || '؟'}، المواد: ${(profile.subjects || []).join('، ')}.\nاليوم: ${C.dayNameAr(today)} ${today}. مواقيت الصلاة (فجر/ظهر/عصر/مغرب/عشاء): ${pr}. موعد نومها: ${profile.sleepTime}. مهامها: ${tasks}. عاداتها: ${habits}.`;
}
async function aiChat(text) {
  const b = addMsg('ai', '<span class="thinking">تفكر…</span>', { time: nowTime() });
  streaming = true; setInputEnabled(false);
  try {
    const msgs = [{ role: 'system', content: systemContext() }].concat(history.slice(-8), [{ role: 'user', content: text }]);
    const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { provider: 'gemini', baseUrl: '', apiKey: '', model: profile && profile.model ? profile.model : 'gemini-flash-lite-latest' }, messages: msgs }) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '', full = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim(); if (d === '[DONE]') continue;
        let o; try { o = JSON.parse(d); } catch { continue; }
        if (o.error) throw new Error(o.error);
        if (o.notice) toast(o.notice);
        if (o.t) { full += o.t; b.innerHTML = md(full); scroll(); }
      }
    }
    b.innerHTML = md(full) || '…';
    history.push({ role: 'assistant', content: full });
    if (profile.prefs.voice && full) speak(full);
  } catch (e) {
    b.innerHTML = md('⚠️ ' + friendlyError(e.message));
    history.push({ role: 'assistant', content: '⚠️ ' + friendlyError(e.message) });
  } finally { streaming = false; setInputEnabled(true); }
}

/* ---------- الإدخال ---------- */
const inputEl = () => $('#input');
function setInputEnabled(v) { const i = inputEl(); if (i) i.disabled = !v; const s = $('#sendBtn'); if (s) s.disabled = !v; }
function sendMessage(text) {
  text = (text || '').trim(); if (!text) return;
  if (streaming) { toast('انتظري حتى يكتمل الرد…'); return; }
  if (flow) {
    if (flow.expectsText) { userSay(text); answerFlow(text); return; }
    // إن لم تكن الخطوة نصية، نتعامل مع النص كأمر/سؤال عادي
  }
  const cmd = C.parseCommand(text);
  if (cmd.action && handleCommand(cmd)) { userSay(text); return; }
  userSay(text);
  if ($('#emptyState')) $('#emptyState').style.display = 'none';
  aiChat(text);
}

/* ============================================================
   الصوت (نطق + استماع)
   ============================================================ */
function prepareSpeech(text) {
  let s = String(text || '');
  s = s.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/https?:\/\/\S+/g, ' ');
  s = s.replace(/[#*_>~|]/g, ' ');
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2764}]/gu, ' ');
  s = s.replace(/\bAI\b/gi, 'إيه آي').replace(/\bAPI\b/gi, 'إيه بي آي').replace(/\bOK\b/gi, 'أوكي');
  s = s.replace(/\bGemini\b/gi, 'جيميناي').replace(/\bGoogle\b/gi, 'جوجل').replace(/\bHiwar\b/gi, 'حوار');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}
function speak(text) {
  if (!profile || !profile.prefs.voice) return;
  const t = prepareSpeech(text); if (!t) return;
  stopSpeaking();
  const lang = (profile.prefs && profile.prefs.lang === 'en') ? 'en-US' : 'ar-SA';
  const engine = (profile.prefs && profile.prefs.voiceEngine) || 'google';
  if (engine === 'google') speakGoogle(t, lang); else speakDevice(t, lang);
}
function stopSpeaking() { speakGen++; try { audioEl.pause(); audioEl.src = ''; } catch {} try { window.speechSynthesis && speechSynthesis.cancel(); } catch {} }
function splitChunks(s, n) { const out = []; let i = 0; while (i < s.length) { let j = Math.min(i + n, s.length); if (j < s.length) { const sp = s.lastIndexOf(' ', j); if (sp > i + n * 0.5) j = sp; } out.push(s.slice(i, j).trim()); i = j; } return out.filter(Boolean); }
async function speakGoogle(text, lang) {
  const myGen = ++speakGen;
  try {
    const chunks = splitChunks(text, 160);
    for (const c of chunks) {
      if (myGen !== speakGen) return;
      const url = '/api/tts?lang=' + encodeURIComponent(lang) + '&text=' + encodeURIComponent(c);
      const res = await fetch(url);
      if (!res.ok) throw new Error('tts');
      const blob = await res.blob();
      if (myGen !== speakGen) return;
      const obj = URL.createObjectURL(blob);
      await new Promise((resolve) => {
        audioEl.src = obj; audioEl.onended = () => { URL.revokeObjectURL(obj); resolve(); };
        audioEl.onerror = () => resolve();
        audioEl.play().catch(() => resolve());
      });
    }
  } catch (e) {
    if (myGen === speakGen) speakDevice(text, lang);
  }
}
function speakDevice(text, lang) {
  if (!window.speechSynthesis) return;
  const myGen = ++speakGen;
  try {
    const u = new SpeechSynthesisUtterance();
    const v = pickVoice(lang);
    if (v) u.voice = v;
    u.lang = lang; u.rate = profile.prefs.rate || 1; u.pitch = 1;
    u.text = text.slice(0, 200);
    u.onend = () => {};
    speechSynthesis.speak(u);
  } catch {}
}
function pickVoice(lang) {
  try {
    const vs = speechSynthesis.getVoices();
    return vs.find((v) => v.lang && v.lang.toLowerCase().startsWith(lang.toLowerCase().split('-')[0])) || null;
  } catch { return null; }
}

/* ---------- الاستماع (تحويل الصوت لنص) ---------- */
function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.lang = (profile && profile.prefs.lang === 'en') ? 'en-US' : 'ar-SA';
  r.interimResults = true; r.continuous = true;
  r.onresult = (e) => {
    let final = '', interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const tr = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += tr; else interim += tr;
    }
    if (final) { inputEl().value += final; }
    if (interim) { $('#voiceStatusText').textContent = interim; }
  };
  r.onend = () => {
    listening = false; setMicUI(false);
    if (inputEl().value.trim()) { const tx = inputEl().value; inputEl().value = ''; sendMessage(tx); }
  };
  r.onerror = (e) => {
    listening = false; setMicUI(false);
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('اسمحي للمتصفح باستخدام الميكروفون 🎙️');
  };
  return r;
}
function setMicUI(on) {
  $('#voiceStatus').hidden = !on;
  const wave = $('#inWave'); if (wave) wave.style.display = on ? 'flex' : '';
  const mb = $('#micBtn'); if (mb) mb.classList.toggle('active', on);
}
async function toggleMic() {
  if (!rec) { rec = initRecognition(); }
  if (!rec) { toast('المتصفح لا يدعم الاستماع — استخدمي Chrome أو Edge'); return; }
  if (listening) { try { rec.stop(); } catch {} listening = false; setMicUI(false); return; }
  try {
    await rec.start();
    listening = true; setMicUI(true);
    $('#voiceStatusText').textContent = 'أستمع إليك… تحدثي';
  } catch (e) { toast('اضغطي مرة أخرى واسمحي بالميكروفون'); }
}

/* ---------- التذكيرات والإشعارات ---------- */
let notifTimeouts = [];
function startReminders() { scheduleNotifications(); if (!reminderTimer) reminderTimer = setInterval(scheduleNotifications, 60000); }
function stopReminders() {
  if (reminderTimer) { clearInterval(reminderTimer); reminderTimer = null; }
  clearNotifTimeouts();
}
function clearNotifTimeouts() { notifTimeouts.forEach((id) => clearTimeout(id)); notifTimeouts = []; }

function upcomingReminders() {
  if (!profile) return [];
  const rem = profile.prefs && profile.prefs.reminders;
  if (!rem) return [];
  const today = C.todayStr();
  const items = C.buildSchedule(profile, prayers, today);
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const out = [];
  for (const it of items) {
    let enabled = false;
    if (['homework', 'project', 'exam', 'revision', 'review', 'other', 'task'].includes(it.kind)) enabled = rem.task;
    else if (it.kind === 'habit') enabled = rem.habit;
    else if (it.kind === 'sleep') enabled = rem.sleep;
    else if (it.kind === 'prayer') enabled = rem.prayer;
    else if (it.kind === 'bag') enabled = rem.task;
    else if (it.kind === 'course' || it.kind === 'event') enabled = rem.task;
    if (!enabled) continue;
    const startMin = C.toMin(it.start);
    const advance = (it.kind === 'prayer' || it.kind === 'sleep') ? 15 : 15;
    const fireMin = startMin - advance;
    if (fireMin > nowMin) out.push({ item: it, fireMin, startMin });
  }
  out.sort((a, b) => a.fireMin - b.fireMin);
  return out;
}

function scheduleNotifications() {
  clearNotifTimeouts();
  const ups = upcomingReminders();
  const now = new Date();
  for (const u of ups) {
    const fireAt = new Date();
    fireAt.setHours(Math.floor(u.fireMin / 60), u.fireMin % 60, 0, 0);
    const delay = fireAt.getTime() - now.getTime();
    if (delay <= 0 || delay > 86400000) continue;
    const key = C.todayStr() + '|' + u.item.start + '|' + u.item.title;
    const id = setTimeout(() => {
      if (!firedReminders[key]) { firedReminders[key] = true; fireReminder(u.item, u.startMin - u.fireMin); }
    }, delay);
    notifTimeouts.push(id);
  }
}

function fireReminder(it, minsAhead) {
  const label = (it.kind === 'sleep') ? 'اقترب موعد نومك 😴' : (it.kind === 'prayer') ? 'حان وقت ' + it.title : '⏰ خلال ' + (minsAhead || 15) + ' دقيقة: ' + it.title;
  toast(label);
  if (profile.prefs.reminders.sound) playChime(profile.prefs.reminders.soundChoice || 'chime');
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification('حوار 🌸', { body: label, icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='46' fill='%230a1a05'/%3E%3Ctext x='50' y='70' font-size='60' text-anchor='middle' fill='%23ebf0c0' font-family='serif'%3E%D8%AD%3C/text%3E%3C/svg%3E" }); } catch {}
  }
}

function requestNotifications() {
  if (!('Notification' in window)) { toast('هذا المتصفح لا يدعم الإشعارات'); return; }
  if (Notification.permission === 'granted') { toast('الإشعارات مفعّلة بالفعل ✅'); scheduleNotifications(); return; }
  Notification.requestPermission().then((perm) => {
    if (perm === 'granted') { toast('تم تفعيل الإشعارات 🔔 — ستصل التذكيرات في وقتها'); scheduleNotifications(); }
    else toast('لم تُمنح صلاحية الإشعارات — يمكنك تفعيلها من الإعدادات');
  }).catch(() => {});
}
function playChime(choice) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const freqs = choice === 'bell' ? [880, 660] : choice === 'soft' ? [523, 392] : [1046, 784];
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.5);
      o.connect(g); g.connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.18); o.stop(ctx.currentTime + i * 0.18 + 0.6);
    });
  } catch {}
}

/* ---------- الإعدادات ---------- */
function openSettings() { if (!profile) { toast('أنشئي حسابك أولاً 🌸'); return; } fillSettings(); $('#settingsModal').hidden = false; }
function fillSettings() {
  const p = profile.prefs || {};
  $('#studyWindowSelect').value = p.studyWindow || 'any';
  const rem = p.reminders || {};
  $('#remindSoundInput').checked = !!rem.sound;
  $('#remindSoundSelect').value = rem.soundChoice || 'chime';
  $('#remindTaskInput').checked = rem.task !== false;
  $('#remindSleepInput').checked = rem.sleep !== false;
  $('#remindHabitInput').checked = rem.habit !== false;
  $('#remindPrayerInput').checked = !!rem.prayer;
  $('#autoSpeakInput').checked = !!p.voice;
  $('#voiceEngineSelect').value = p.voiceEngine || 'google';
  $('#voiceLangSelect').value = p.lang === 'en' ? 'en-US' : 'ar-SA';
  $('#rateInput').value = p.rate || 1;
  $('#modelInput').value = profile.model || '';
}
function saveSettings() {
  const p = profile.prefs || {};
  p.studyWindow = $('#studyWindowSelect').value;
  p.reminders = {
    sound: $('#remindSoundInput').checked,
    soundChoice: $('#remindSoundSelect').value,
    task: $('#remindTaskInput').checked,
    sleep: $('#remindSleepInput').checked,
    habit: $('#remindHabitInput').checked,
    prayer: $('#remindPrayerInput').checked,
  };
  p.voice = $('#autoSpeakInput').checked;
  p.voiceEngine = $('#voiceEngineSelect').value;
  p.lang = $('#voiceLangSelect').value === 'en-US' ? 'en' : 'ar';
  p.rate = parseFloat($('#rateInput').value) || 1;
  profile.prefs = p;
  if ($('#modelInput').value.trim()) profile.model = $('#modelInput').value.trim();
  profile.updatedAt = new Date().toISOString();
  saveProfile();
  $('#settingsModal').hidden = true;
  if (p.reminders.sound && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
  toast('حُفظت الإعدادات ✅');
}

/* ---------- الأحداث ---------- */
function bindUI() {
  $('#tryNowBtn').addEventListener('click', () => { if (token) enterApp(); else goAuth(); });
  $('#voiceTryBtn').addEventListener('click', () => { if (token) enterApp(); else goAuth(); });
  $('#brandBtn').addEventListener('click', () => showScreen('landing'));
  $('#menuBtn').addEventListener('click', openSidebar);
  $('#sidebarCloseBtn').addEventListener('click', closeSidebar);
  $('#sidebarScrim').addEventListener('click', closeSidebar);
  $('#scheduleBtn').addEventListener('click', openSchedule);
  $('#closeScheduleBtn').addEventListener('click', () => { $('#scheduleModal').hidden = true; });
  $('#addTaskBtn').addEventListener('click', () => { $('#scheduleModal').hidden = true; startFlow(addTaskFlow(), afterDaily); });
  $('#repeatTomorrowBtn').addEventListener('click', repeatTomorrow);
  $('#aiAdviceBtn').addEventListener('click', () => { $('#scheduleModal').hidden = true; aiAdvice(); });
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsBtn2').addEventListener('click', openSettings);
  $('#closeSettingsBtn').addEventListener('click', () => { $('#settingsModal').hidden = true; });
  $('#saveSettingsBtn').addEventListener('click', saveSettings);
  $('#resetSettingsBtn').addEventListener('click', () => { profile.prefs = C.defaultProfile().prefs; fillSettings(); });
  $('#testVoiceBtn').addEventListener('click', () => speak('مرحباً، أنا حوار، رفيقتك الذكية. هل تسمعينني بوضوح؟'));
  $('#logoutBtn').addEventListener('click', logout);
  $('#voiceToggleBtn').addEventListener('click', () => { profile.prefs.voice = !profile.prefs.voice; saveProfile(); toast(profile.prefs.voice ? 'الرد الصوتي مفعّل 🔊' : 'الرد الصوتي متوقف 🔇'); });
  $('#sendBtn').addEventListener('click', () => { const i = inputEl(); sendMessage(i.value); i.value = ''; autoGrow(); });
  inputEl().addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const i = inputEl(); sendMessage(i.value); i.value = ''; autoGrow(); } });
  inputEl().addEventListener('input', autoGrow);
  $('#micBtn').addEventListener('click', toggleMic);
  $('#stopVoiceBtn').addEventListener('click', () => { if (rec) try { rec.stop(); } catch {} listening = false; setMicUI(false); });
  $('#exitVoiceModeBtn').addEventListener('click', () => { voiceChatMode = false; $('#voiceModeBanner').hidden = true; });
  // النقر خارج النوافذ
  $$('.modal-backdrop').forEach((mb) => mb.addEventListener('click', (e) => { if (e.target === mb) mb.hidden = true; }));
}
function autoGrow() { const i = inputEl(); if (!i) return; i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, 140) + 'px'; }
function openSidebar() { $('#sidebar').classList.add('open'); $('#sidebarScrim').classList.add('show'); renderPanel(); }
function closeSidebar() { $('#sidebar').classList.remove('open'); $('#sidebarScrim').classList.remove('show'); }

/* ---------- الإقلاع ---------- */
async function boot() {
  bindAuth();
  bindUI();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleNotifications(); });
  if ('serviceWorker' in navigator) { try { navigator.serviceWorker.register('/sw.js'); } catch {} }
  if (token) {
    try {
      const me = await api('GET', '/api/auth/me');
      user = me.user;
      profile = Object.assign(C.defaultProfile(), me.profile || {});
      enterApp();
    } catch (e) {
      token = null; localStorage.removeItem('hiwar.token');
      showScreen('landing');
    }
  } else {
    showScreen('landing');
  }
}
document.addEventListener('DOMContentLoaded', boot);
