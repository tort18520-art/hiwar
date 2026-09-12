/* ============================================================
   Hiwar (حوار) — منطق الرفيقة الذكية (جدولة + عادات + تخصيص)
   يُحمَّل قبل app.js ويعرّف window.Companion
   ============================================================ */
window.Companion = (function () {
  'use strict';

  const GRADE_INFO = {
    first:  { name: 'الأولى', label: 'الأول الثانوي', subjects: ['الرياضيات', 'اللغة العربية', 'اللغة الإنجليزية', 'الكيمياء', 'الفيزياء', 'الأحياء', 'الاجتماعيات', 'التربية الإسلامية', 'المهارات الرقمية'] },
    second: { name: 'الثانية', label: 'الثاني الثانوي', subjects: ['الرياضيات', 'الفيزياء', 'الكيمياء', 'الأحياء', 'اللغة العربية', 'اللغة الإنجليزية', 'القرآن الكريم', 'المهارات الرقمية'] },
    third:  { name: 'الثالثة', label: 'الثالث الثانوي', subjects: ['الرياضيات', 'الفيزياء', 'الكيمياء', 'الأحياء', 'اللغة العربية', 'اللغة الإنجليزية', 'القرآن الكريم'] },
  };

  const HS8 = { school: 'الثانوية الثامنة', start: '06:45', end: '13:15' };

  const DAYS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

  const ICON = { school: '🏫', prayer: '🕌', sleep: '😴', course: '📚', event: '📅', homework: '📝', project: '📊', exam: '📖', revision: '🔁', habit: '⭐', care: '🌸', bag: '🎒', break: '☕', other: '📌', review: '🌅', rest: '🛋️', fun: '🎨', idea: '💡' };

  const STUDY_KINDS = ['homework', 'project', 'exam', 'revision', 'review', 'other'];

  /* ---------- ملف افتراضي ---------- */
  function defaultProfile() {
    return {
      version: 2, onboardingDone: false,
      city: null, school: null, schoolName: '', section: '', grade: null, subjects: [],
      schoolStart: HS8.start, schoolEnd: HS8.end,
      sleepTime: '22:00', wakeTime: '05:30',
      personalCare: null, bagReminder: false,
      courses: [], tasks: [], events: [], habits: [],
      prefs: { voice: true, lang: 'ar', studyWindow: 'any', reminders: { sound: true, soundChoice: 'chime', task: true, sleep: true, habit: true, prayer: false } },
      stats: { done: 0, habitChecks: 0, sleepDays: 0, byHour: {}, delays: {} },
      lastDaily: null,
    };
  }

  /* ---------- أدوات الوقت ---------- */
  function pad(n) { return String(n).padStart(2, '0'); }
  function toMin(hhmm) {
    if (!hhmm) return 0;
    const [h, m] = String(hhmm).split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }
  function fmtMin(min) {
    min = ((Math.round(min) % 1440) + 1440) % 1440;
    return pad(Math.floor(min / 60)) + ':' + pad(min % 60);
  }
  function todayStr(offset) {
    const d = new Date();
    if (offset) d.setDate(d.getDate() + offset);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function dateFromStr(s) { return new Date(s + 'T00:00:00'); }
  function dayIndex(s) { return dateFromStr(s).getDay(); }
  function isSchoolDay(s) { const d = dayIndex(s); return d >= 0 && d <= 4; }
  function dayNameAr(s) { return DAYS_AR[dayIndex(s)]; }
  function fmtDateAr(s) {
    const d = dateFromStr(s);
    return dayNameAr(s) + ' ' + d.getDate() + '/' + (d.getMonth() + 1);
  }
  function addDaysStr(s, n) {
    const d = dateFromStr(s); d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /* ---------- أولوية المهمة ---------- */
  function taskPriority(t, today) {
    const typeW = { exam: 500, project: 300, homework: 150, event: 400, other: 80 };
    let w = typeW[t.type] || 80;
    if (t.dueDate) {
      const days = Math.round((dateFromStr(t.dueDate) - dateFromStr(today)) / 86400000);
      if (days < 0) w += 300;
      else w -= days * 15;
    }
    return w;
  }

  /* ---------- توليد الجدول الذكي ---------- */
  function buildSchedule(profile, prayers, dateStr) {
    const sleep = toMin(profile.sleepTime || '22:00');
    const wake = toMin(profile.wakeTime || '05:30');
    const fajrMin = prayers && prayers.fajr ? toMin(prayers.fajr) : wake;
    const wakeMin = Math.min(wake, Math.max(0, fajrMin - 25));
    const flexStart = Math.max(wake, fajrMin); // لا مذاكرة قبل الفجر
    const schoolDay = isSchoolDay(dateStr);
    const todayIdx = dayIndex(dateStr);

    const intervals = []; // [start, end, kind, title, icon]

    if (prayers) {
      const P = [['fajr', 'الفجر'], ['dhuhr', 'الظهر'], ['asr', 'العصر'], ['maghrib', 'المغرب'], ['isha', 'العشاء']];
      for (const [k, nm] of P) {
        const t = toMin(prayers[k]);
        intervals.push([t, t + 20, 'prayer', 'صلاة ' + nm, '🕌']);
      }
    }
    if (schoolDay && profile.school) {
      intervals.push([toMin(profile.schoolStart || HS8.start), toMin(profile.schoolEnd || HS8.end), 'school', 'اليوم الدراسي', '🏫']);
    }
    for (const c of (profile.courses || [])) {
      if ((c.days || []).includes(todayIdx) && c.time) {
        intervals.push([toMin(c.time), toMin(c.time) + 60, 'course', 'دورة: ' + c.name, '📚']);
      }
    }
    for (const ev of (profile.events || [])) {
      if (ev.date === dateStr && ev.fixed && ev.time) {
        intervals.push([toMin(ev.time), toMin(ev.time) + 60, 'event', ev.title, '📅']);
      }
    }
    if (profile.personalCare === 'afterIsha' && prayers) {
      const t = toMin(prayers.isha);
      intervals.push([t, t + 30, 'care', 'العناية الشخصية', '🌸']);
    } else if (profile.personalCare === 'beforeSleep') {
      intervals.push([sleep - 30, sleep, 'care', 'العناية الشخصية', '🌸']);
    }
    if (profile.bagReminder) intervals.push([sleep - 15, sleep, 'bag', 'تجهيز الحقيبة', '🎒']);
    intervals.push([sleep, 1440, 'sleep', 'النوم', '😴']);

    // قصّ الفترات داخل نافذة اليقظة
    const clamped = intervals
      .map((iv) => [Math.max(iv[0], wakeMin), Math.min(iv[1], sleep), iv[2], iv[3], iv[4]])
      .filter((iv) => iv[1] - iv[0] >= 10);
    clamped.sort((a, b) => a[0] - b[0]);

    const fixedItems = clamped.map((iv) => ({
      start: fmtMin(iv[0]), end: iv[1] >= 1439 ? '24:00' : fmtMin(iv[1]),
      title: iv[3], kind: iv[2], icon: iv[4], fixed: true,
    }));

    // دمج الفترات لحساب الفراغات
    const merged = [];
    for (const iv of clamped) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
      else merged.push([iv[0], iv[1]]);
    }
    const gaps = [];
    let cur = flexStart;
    for (const iv of merged) {
      if (iv[0] > cur + 10) gaps.push([cur, iv[0]]);
      cur = Math.max(cur, iv[1]);
    }
    if (sleep > cur + 10) gaps.push([cur, sleep]);

    // تفضيل نافذة المذاكرة
    const pref = (profile.prefs && profile.prefs.studyWindow) || 'any';
    const anchor = (pref === 'afterAsr' && prayers) ? toMin(prayers.asr)
      : (pref === 'afterMaghrib' && prayers) ? toMin(prayers.maghrib)
      : (pref === 'morning') ? flexStart : null;
    if (anchor != null) {
      gaps.sort((a, b) => ((a[0] >= anchor ? 0 : 1) - (b[0] >= anchor ? 0 : 1)) || (a[0] - b[0]));
    } else gaps.sort((a, b) => a[0] - b[0]);

    // عناصر مرنة
    const flex = [];
    for (const task of (profile.tasks || [])) {
      if (task.done) continue;
      const days = task.dueDate ? Math.round((dateFromStr(task.dueDate) - dateFromStr(dateStr)) / 86400000) : 0;
      if (task.dueDate && task.dueDate !== dateStr && days > 0) {
        if (task.type === 'exam' && days <= 7) {
          flex.push({ title: 'مراجعة ' + (task.subject || '') + (task.title ? ': ' + task.title : ''), kind: 'revision', durationMin: Math.min(task.durationMin || 30, 45), priority: 380 - days * 25, subject: task.subject });
        } else if (task.type === 'project' && days <= 5) {
          flex.push({ title: 'جزء من: ' + (task.title || task.subject || ''), kind: 'project', durationMin: Math.min(task.durationMin || 60, 45), priority: 300 - days * 20, subject: task.subject });
        }
        continue;
      }
      flex.push({ ...task, kind: task.kind || task.type || 'other', title: task.title || (task.subject || '') + (task.type === 'exam' ? ' — اختبار' : ''), priority: taskPriority(task, dateStr), durationMin: task.durationMin || 30 });
    }
    for (const ev of (profile.events || [])) {
      if (ev.date === dateStr && !ev.fixed) {
        flex.push({ title: ev.title, kind: 'event', durationMin: 45, priority: 400 });
      }
    }
    for (const h of (profile.habits || [])) {
      const freq = h.frequency || 'daily';
      const active = freq === 'daily' || (freq === 'weekdays' && todayIdx <= 4) || (h.days && h.days.includes(todayIdx));
      if (active && !habitDoneToday(h, dateStr)) {
        flex.push({ title: 'عادة: ' + (h.name || ''), kind: 'habit', durationMin: h.durationMin || 15, priority: 120, time: h.time });
      }
    }

    flex.sort((a, b) => (b.priority || 0) - (a.priority || 0));

    // توزيع داخل الفراغات
    let studyMin = 0;
    const placed = [];
    const queue = flex.slice();
    while (queue.length) {
      const item = queue.shift();
      let dur = Math.min(item.durationMin || 30, 60);
      let chosenGap = null, chosenStart = null;
      if (item.time) {
        const tt = toMin(item.time);
        for (const g of gaps) {
          const s = Math.max(g[0], tt);
          if (g[1] - s >= Math.min(dur, 45)) { chosenGap = g; chosenStart = s; break; }
        }
      }
      if (!chosenGap) {
        for (const g of gaps) if (g[1] - g[0] >= 20) { chosenGap = g; chosenStart = g[0]; break; }
      }
      if (!chosenGap) continue;
      const avail = chosenGap[1] - chosenStart;
      if (avail < 15) continue;
      let use = Math.min(dur, avail);
      const isStudy = STUDY_KINDS.includes(item.kind);
      if (isStudy) {
        if (use > 45) use = 45;
        if (studyMin + use > 300) use = Math.max(0, 300 - studyMin);
        if (use < 15) continue;
        studyMin += use;
      }
      placed.push({ start: fmtMin(chosenStart), end: fmtMin(chosenStart + use), title: item.title, kind: item.kind, icon: ICON[item.kind] || '📌', subject: item.subject, taskId: item.id });
      chosenGap[0] = chosenStart + use;
      const rem = (item.durationMin || 0) - use;
      if (rem >= 15) queue.push({ ...item, durationMin: rem, title: item.title + ' (تابع)' });
    }

    if (studyMin >= 60) {
      const free = gaps.filter((g) => g[1] - g[0] >= 30);
      if (free.length) {
        placed.push({ start: fmtMin(free[0][0]), end: fmtMin(free[0][0] + 25), title: 'استراحة وترفيه', kind: 'break', icon: '☕' });
        free[0][0] += 25;
      }
    }

    const out = fixedItems.concat(placed.map((p) => ({ ...p, fixed: false })));
    out.sort((a, b) => toMin(a.start) - toMin(b.start) || ((a.fixed ? 0 : 1) - (b.fixed ? 0 : 1)));
    return out;
  }

  function timelineSummary(items) {
    return (items || []).map((it) => `${it.start}-${it.end} ${it.icon || ''} ${it.title}`).join(' | ');
  }

  /* ---------- العادات ---------- */
  function habitDoneToday(h, dateStr) { return !!(h.history && h.history[dateStr]); }
  function habitStreak(h, dateStr) {
    let n = 0;
    let d = dateStr;
    while (h.history && h.history[d]) { n++; d = addDaysStr(d, -1); }
    return n;
  }
  function checkHabit(profile, habitId, done, dateStr) {
    const h = (profile.habits || []).find((x) => x.id === habitId);
    if (!h) return { profile, message: '' };
    h.history = h.history || {};
    h.history[dateStr] = !!done;
    let message = '';
    if (done) {
      h.streak = habitStreak(h, dateStr);
      h.best = Math.max(h.best || 0, h.streak);
      profile.stats.habitChecks = (profile.stats.habitChecks || 0) + 1;
      if (h.streak >= 2) message = `ما شاء الله! ${h.streak} أيام متتالية في «${h.name}» — استمري، أنتِ رائعة 🌟`;
      else message = `أحسنتِ! سُجّلت عادة «${h.name}» اليوم ✅`;
    } else {
      h.streak = 0;
      message = `لا بأس، غداً يوم جديد. سنواصل «${h.name}» معاً بإذن الله 💪`;
    }
    return { profile, message };
  }

  /* ---------- اقتراحات التخصيص ---------- */
  function suggestions(profile) {
    const out = [];
    const today = todayStr();
    const overdue = (profile.tasks || []).filter((t) => !t.done && t.dueDate && t.dueDate < today);
    if (overdue.length) out.push(`لديكِ ${overdue.length} مهمة متأخرة — أقترح أن نبدأ بها اليوم فوراً.`);
    const byHour = profile.stats && profile.stats.byHour ? Object.entries(profile.stats.byHour).sort((a, b) => b[1] - a[1]) : [];
    if (byHour.length >= 3) {
      const h = Number(byHour[0][0]);
      let when = 'بعد العصر';
      if (h >= 17) when = 'بعد المغرب';
      else if (h < 11) when = 'في الصباح الباكر';
      out.push(`أنجزتِ مهامك غالباً ${when} — هل أجعل جلسات المذاكرة في هذا الوقت؟`);
    }
    const delays = profile.stats && profile.stats.delays ? Object.entries(profile.stats.delays).sort((a, b) => b[1] - a[1]) : [];
    if (delays.length) out.push(`ألاحظ تأخراً متكرراً في «${delays[0][0]}» — أقترح جلسة يومية ثابتة لها.`);
    if (profile.stats && profile.stats.sleepDays >= 3) out.push('حافظتِ على نومك المبكر ' + profile.stats.sleepDays + ' أيام، عمل رائع 🌙');
    return out;
  }

  /* ---------- تحليل الأوامر النصية ---------- */
  function parseCommand(text) {
    const s = String(text || '').trim();
    const add = s.match(/^(?:أضيفي|أضف|ضيفي|إضافة|add)\s+(?:مهمة|واجب|مشروع|اختبار|نشاط)?\s*[:：]?\s*(.+)$/i);
    if (add) return { action: 'add', text: add[1].trim() };
    const del = s.match(/^(?:احذفي|احذف|حذف|امسحي|delete|remove)\s+(?:مهمة|المهمة|من|جلسة)?\s*[:：]?\s*(.+)$/i);
    if (del) return { action: 'delete', text: del[1].trim() };
    const mv = s.match(/^(?:انقلي|انقل|نقل|حركي)\s+(.+?)\s+(?:إلى|بعد|قبل)\s+(.+)$/i);
    if (mv) return { action: 'move', text: mv[1].trim(), to: mv[2].trim() };
    if (/^(?:كرري|كرر|تكرار|repeat)/i.test(s) && /(?:غداً|بكرة|باجر|tomorrow)/i.test(s)) return { action: 'repeat' };
    if (/^(?:جدول|خطة|برنامج|خطتي|يومي)\s*(?:اليوم|حياتي)?$/i.test(s) || /show.*schedule/i.test(s)) return { action: 'today' };
    if (/(?:فكرة|افكار|اقترح|اقترحي|مشروع)/.test(s) && /(?:مشروع|فكرة|اقترح)/.test(s)) return { action: 'idea', text: s };
    return { action: null };
  }

  /* ---------- مكتبة أفكار مشاريع مدرسية ---------- */
  const PROJECT_IDEAS = {
    'الفيزياء': [
      { title: 'نموذج الطاقة الشمسية المنزلي', goal: 'توليد كهرباء لإنارة مصباح صغير بلوح شمسي.', steps: ['اجمعي لوح شمسي صغير وبطارية ومصباح LED وأسلاكاً.', 'ارسمي مخطط التوصيل (لوح ← منظم ← بطارية ← مصباح).', 'ثبّتي اللوح بزاوية نحو الشمس ووصّلي الأسلاك.', 'جرّبي الإضاءة نهاراً وسجّلي النتائج.', 'جهّزي لوحة عرض توضح تحول الطاقة خطوة بخطوة.'] },
      { title: 'قياس التسارع بهاتفك', goal: 'دراسة حركة الأجسام بمستشعر التسارع في الجوال.', steps: ['نزّلي تطبيقاً مجانياً لقراءة مستشعر التسارع.', 'ركّبي الهاتف على لعبة متحركة أو كرة.', 'سجّلي قيم التسارع خلال الحركة في جدول.', 'ارسمي منحنى السرعة والزمن وفسّريه.'] },
    ],
    'الكيمياء': [
      { title: 'صناعة صابون طبيعي منزلي', goal: 'فهم تفاعل التصبّن وتطبيقه عملياً.', steps: ['جهّزي زيت زيتون وهيدروكسيد صوديوم بحذر (مع كمامة وقفازات).', 'اخلطي الزيت والمحلول ببطء مع التحريك حتى التماسك.', 'أضيفي عطراً أو لوناً طبيعياً.', 'صبّي الخليط في قوالب واتركيه 24 ساعة.', 'اكتبي معادلة التصبّن وناقشي السلامة في التقرير.'] },
      { title: 'مؤشر حموضة طبيعي', goal: 'استخدام الملفوف الأحمر لقياس درجة الحموضة.', steps: ['اغلي أوراق ملفوف أحمر لاستخراج الصبغة.', 'جهّزي محاليل منزلية (ليمون، صابون، خل، ماء).', 'أضيفي الصبغة لكل محلول ولاحظي تغيّر اللون.', 'رتّبي المواد حسب حموضتها في جدول ملوّن.'] },
    ],
    'الأحياء': [
      { title: 'تجربة نمو النبات تحت ضوء مختلف', goal: 'مقارنة نمو البذور بضوء الشمس والضوء الصناعي والظلام.', steps: ['ازرعي بذوراً متطابقة في ثلاثة أوعية.', 'ضعي كل وعاء في بيئة إضاءة مختلفة.', 'سجّلي الطول وعدد الأوراق يومياً لمدة أسبوعين.', 'ارسمي منحنى النمو وقارني النتائج.'] },
      { title: 'مطوية الجهاز الدوري التفاعلية', goal: 'عرض مجسم لمسار الدم في القلب والرئتين.', steps: ['ارسمي القلب على لوح كرتوني.', 'حدّدي الحجرات الأربع والأوعية الداخلة والخارجة.', 'لوّني مسار الدم المؤكسج بالأحمر وغير المؤكسج بالأزرق.', 'أضيفي أسهم اتجاه سريان الدم وشرحاً موجزاً.'] },
    ],
    'الرياضيات': [
      { title: 'لوحة تطبيقية لنظرية فيثاغورس', goal: 'إثبات النظرية بمجسم مفرغ قابلة للتركيب.', steps: ['قصّي مربعات على أضلاع مثلث قائم من الورق المقوى.', 'ثبتيها على لوحة توضح أن مجموع مربعي الضلعين يساوي مربع الوتر.', 'أضيفي أمثلة عددية وحلولاً.'] },
      { title: 'إحصاء عادات الطالبات', goal: 'مسح إحصائي بسيط وعرض النتائج برسوم بيانية.', steps: ['صممي استبياناً قصيراً (5 أسئلة) لزميلاتك.', 'جمعي 30 إجابة على الأقل.', 'مثّلي النتائج بالأعمدة والدائرة.', 'احسبي المتوسط والنسبة المئوية واكتبي استنتاجاتك.'] },
    ],
    'اللغة العربية': [
      { title: 'قاموس مصوّر للألفاظ القرآنية', goal: 'شرح 20 كلمة قرآنية بالصور والمرادفات.', steps: ['اختاري 20 كلمة من آيات مقررة.', 'ابحثي عن معناها في كتب التفسير.', 'صممي بطاقة لكل كلمة (معنى، صورة، مثال).', 'اجمعيها في دفتر أو عرض رقمي أنيق.'] },
      { title: 'ديوان شعر عن الطموح', goal: 'تأليف مجموعة قصائد/خواطر قصيرة.', steps: ['اقرئي نماذج شعرية ملهمة.', 'اكتبي 5 خواطر بلغة سليمة.', 'نسّقيها في كتيّب مع مقدمة وخاتمة.'] },
    ],
    'اللغة الإنجليزية': [
      { title: 'عرض عن يومي المدرسي', goal: 'ممارسة التحدث بالإنجليزية عبر عرض تقديمي.', steps: ['اكتبي جملاً عن يومك الدراسي.', 'جهّزي 6 شرائح مصورة.', 'درّبي نفسك على النطق ثم قدّميها أمام الصف.'] },
      { title: 'مجلة إنجليزية صغيرة', goal: 'إصدار نشرة إخبارية بالإنجليزية.', steps: ['اختاري 4 مواضيع (مدرسة، رياضة، صحة، ترفيه).', 'اكتبي مقالاً قصيراً لكل موضوع.', 'نسّقيها بصور وعناوين جذابة.'] },
    ],
    'المهارات الرقمية': [
      { title: 'موقع/عرض تعريفي عن مدرستك', goal: 'تصميم صفحة تعرّف بالمدرسة والأنشطة.', steps: ['جمعي صوراً ومعلومات عن المدرسة.', 'صممي عرضاً تقديمياً أو صفحة بسيطة.', 'أضيفي روابط وألواناً متناسقة واختبريها.'] },
      { title: 'حملة توعية رقمية عن التنمر الإلكتروني', goal: 'توعية الطالبات بالاستخدام الآمن للإنترنت.', steps: ['ابحثي عن أشكال التنمر الإلكتروني وطرق الوقاية.', 'صممي منشورات توعوية.', 'اعرضيها على الزميلات واجمعي آراءهن.'] },
    ],
    '_default': [
      { title: 'بحث مصغّر مع عرض تقديمي', goal: 'التعمق في موضوع من المقرر وتقديمه.', steps: ['اختاري موضوعاً من الكتاب.', 'اجمعي معلومات من 3 مصادر موثوقة.', 'لخّصيها في 6 شرائح.', 'أضيفي صوراً وخاتمة بخلاصة.'] },
      { title: 'لوحة تعليمية تفاعلية', goal: 'شرح درس بلوحة ملوّنة وملصقات.', steps: ['حددي أهم أفكار الدرس.', 'صممي اللوحة بعناوين وألوان.', 'أضيفي بطاقات أسئلة وأجوبة متحركة.'] },
    ],
  };

  function projectIdeasFor(subject) {
    const s = String(subject || '').trim();
    const key = Object.keys(PROJECT_IDEAS).find((k) => s.includes(k));
    return PROJECT_IDEAS[key || '_default'] || PROJECT_IDEAS._default;
  }
  function formatIdeas(subject) {
    const ideas = projectIdeasFor(subject);
    let out = '💡 إليكِ أفكار مشاريع رائعة لمادة «' + subject + '»:\n\n';
    ideas.forEach((idea, i) => {
      out += '**' + (i + 1) + '. ' + idea.title + '**\n';
      out += '🎯 الهدف: ' + idea.goal + '\n\n📋 **خطة التنفيذ:**\n';
      idea.steps.forEach((st, j) => { out += (j + 1) + ') ' + st + '\n'; });
      out += '\n';
    });
    out += 'أخبريني بأي فكرة أعجبتكِ وسأساعدك في تقسيمها إلى مهام يومية 📆';
    return out;
  }

  return {
    defaultProfile, GRADE_INFO, HS8, DAYS_AR, ICON,
    toMin, fmtMin, todayStr, addDaysStr, dateFromStr, dayIndex, isSchoolDay, dayNameAr, fmtDateAr,
    buildSchedule, timelineSummary, taskPriority,
    habitDoneToday, habitStreak, checkHabit, suggestions, parseCommand,
    projectIdeasFor, formatIdeas,
  };
})();
