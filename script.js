/* ==============================
   أعراف - المساعد القانوني الذكي
   Frontend JavaScript
   ============================== */

var V = 'home';
var RES = null;
var ERR = null;
var STEP = 0;
var LQ = '';
var TQ = '';

var TP = [
  'حقوق العامل عند الفصل التعسفي',
  'نظام العمل السعودي الجديد',
  'إجراءات رفع دعوى عمالية',
  'تعويضات إصابات العمل',
  'عقود العمل المحددة المدة',
  'حقوق المرأة العاملة',
  'نظام التأمينات الاجتماعية',
  'الفرق بين الاستقالة وإنهاء العقد'
];

var ST = [
  'تحليل الاستفسار وتحديد الأنظمة ذات الصلة...',
  'البحث في أنظمة هيئة الخبراء والمواقع الرسمية...',
  'البحث في المقالات ومنصات التواصل الاجتماعي...',
  'إعداد الدراسة القانونية الموثقة...'
];

/* === Helpers === */
function $(i) { return document.getElementById(i); }

function toast(m) {
  var t = $('T');
  t.textContent = m;
  t.classList.add('show');
  setTimeout(function() { t.classList.remove('show'); }, 2000);
}

/* === Render Router === */
function R() {
  var m = $('M');
  if (V === 'home') m.innerHTML = vHome();
  else if (V === 'loading') m.innerHTML = vLoad();
  else if (V === 'result') m.innerHTML = vRes();
  else if (V === 'error') m.innerHTML = vErr();
}

/* === Home View === */
function vHome() {
  var h = '<section class="hero fd">';
  h += '<div class="hic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg></div>';
  h += '<h1>مساعدك القانوني <span class="gld">الذكي</span></h1>';
  h += '<p>بحث قانوني عميق يبدأ من الأنظمة السعودية الرسمية ثم يتوسع لجميع المصادر — كل معلومة موثقة بمصدرها ورابطها</p>';
  h += '</section>';

  h += '<div class="sb fd" style="animation-delay:.1s">';
  h += '<div class="st">';
  h += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>';
  h += '<textarea class="si" id="si" rows="1" placeholder="اكتب استفسارك القانوني..." oninput="this.style.height=\'auto\';this.style.height=this.scrollHeight+\'px\'" onkeydown="if(event.key===\'Enter\'&&!event.shiftKey){event.preventDefault();go()}"></textarea>';
  h += '</div>';
  h += '<div class="sf">';
  h += '<div class="shs">';
  h += '<span class="sh"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>يبدأ بالأنظمة الرسمية</span>';
  h += '<span class="sh"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>كل معلومة بمصدرها</span>';
  h += '</div>';
  h += '<button class="btn" onclick="go()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14"/><path d="M12 5l-7 7 7 7"/></svg>ابحث الآن</button>';
  h += '</div></div>';

  h += '<div class="tps fd" style="animation-delay:.2s">';
  for (var i = 0; i < TP.length; i++) {
    h += '<button class="ch" onclick="TQ=\'' + TP[i] + '\';go()">' + TP[i] + '</button>';
  }
  h += '</div>';
  return h;
}

/* === Loading View === */
function vLoad() {
  var h = '<div class="lw fd"><div class="lsp"></div>';
  h += '<div class="lt">جارٍ البحث العميق والتحليل</div>';
  h += '<div class="ls">يتم البحث في الأنظمة السعودية والمصادر القانونية...</div>';
  h += '<div class="stp">';
  for (var i = 0; i < ST.length; i++) {
    var c = STEP > i ? 'ok' : STEP === i ? 'on' : '';
    var ic;
    if (STEP > i) {
      ic = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>';
    } else if (STEP === i) {
      ic = '<div class="msp"></div>';
    } else {
      ic = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity=".3"><circle cx="12" cy="12" r="3"/></svg>';
    }
    h += '<div class="ss ' + c + '" id="s' + i + '"><div class="si2">' + ic + '</div><span>' + ST[i] + '</span></div>';
  }
  h += '</div></div>';
  return h;
}

/* === Result View === */
function vRes() {
  if (!RES) return '';
  var txt = RES.content.replace(/<[^>]*>/g, '');
  var wc = txt.split(/\s+/).filter(function(w) { return w; }).length;
  var sn = RES.sources ? RES.sources.length : 0;

  var h = '<div class="rw fd">';
  // Header
  h += '<div class="rh"><div class="rq"><div class="rqi"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg></div><span class="rqt">' + LQ + '</span></div>';
  h += '<div class="rac"><button class="ab" onclick="cpR()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>نسخ</button>';
  h += '<button class="ab" onclick="prR()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>طباعة</button></div></div>';

  // Article Card
  h += '<div class="ac"><div class="am">';
  h += '<div class="mt nv"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/></svg>' + (RES.type || 'دراسة قانونية') + '</div>';
  h += '<div class="mt"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>' + new Date().toLocaleDateString('ar-SA') + '</div>';
  h += '<div class="wc">' + wc + ' كلمة</div>';
  h += '<div class="mt"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>' + sn + ' مصادر</div>';
  h += '</div>';

  // Body
  h += '<div class="ab2" id="AB">' + RES.content;

  // Sources
  if (RES.sources && RES.sources.length) {
    h += '<div class="sc"><div class="sct"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>فهرس المصادر</div>';
    for (var i = 0; i < RES.sources.length; i++) {
      var s = RES.sources[i];
      var tp = (s.type || '').toLowerCase();
      var b = '<span class="tb a">مقالة</span>';
      if (tp.indexOf('رسمي') > -1 || tp.indexOf('نظام') > -1) b = '<span class="tb o">رسمي</span>';
      else if (tp.indexOf('تواصل') > -1 || tp.indexOf('تويتر') > -1 || tp.indexOf('تيك') > -1) b = '<span class="tb s">تواصل اجتماعي</span>';
      else if (tp.indexOf('فيديو') > -1 || tp.indexOf('يوتيوب') > -1) b = '<span class="tb v">فيديو</span>';
      h += '<div class="sci"><span class="scn">' + (i + 1) + '</span><div><div style="font-weight:600;color:var(--nv);margin-bottom:2px">' + b + s.title + '</div>';
      if (s.date) h += '<span style="font-size:10px;color:var(--tm)">📅 ' + s.date + '</span><br>';
      if (s.url) h += '<a href="' + s.url + '" target="_blank" class="scl">' + s.url + '</a>';
      h += '</div></div>';
    }
    h += '</div>';
  }

  h += '</div></div>';
  h += '<button class="nb" onclick="goH()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>بحث جديد</button>';
  h += '</div>';
  return h;
}

/* === Error View === */
function vErr() {
  return '<div class="er fd"><div class="eri"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div><div class="ert">حدث خطأ أثناء البحث</div><div class="erm">' + (ERR || 'يرجى المحاولة مرة أخرى') + '</div><button class="rb" onclick="go()">إعادة المحاولة</button> <button class="rb" onclick="goH()">العودة</button></div>';
}

/* === Navigation === */
function goH() {
  V = 'home'; RES = null; ERR = null; TQ = '';
  R();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* === Copy === */
function cpR() {
  var b = $('AB');
  if (b) {
    navigator.clipboard.writeText(b.innerText).then(function() { toast('تم النسخ'); });
  }
}

/* === Print === */
function prR() {
  var b = $('AB');
  if (!b) return;
  var w = window.open('', '_blank');
  w.document.write('<html dir="rtl"><head><meta charset="UTF-8"><title>تقرير - أعراف</title><link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700&family=Cairo:wght@700&display=swap" rel="stylesheet"><style>body{font-family:Tajawal,sans-serif;padding:32px;line-height:2;color:#1a1a1a}h2{font-family:Cairo;color:#1B3A4B;border-bottom:2px solid #C9A96E;padding-bottom:8px}h3{font-family:Cairo;color:#1B3A4B;margin-top:20px}blockquote{border-right:3px solid #C9A96E;padding:8px 16px;background:#FDF8F0;margin:12px 0}strong{color:#1B3A4B}a{color:#3D7B8A}table{width:100%;border-collapse:collapse}th{background:#F2E8D0;padding:6px 10px;text-align:right;border-bottom:2px solid #C9A96E}td{padding:6px 10px;border-bottom:1px solid #e0d5c0}</style></head><body><div style="text-align:center;margin-bottom:20px"><h2>شركة أعراف للمحاماة والاستشارات القانونية</h2><p style="color:#666;font-size:12px">تقرير قانوني — ' + new Date().toLocaleDateString('ar-SA') + '</p><hr style="border:1px solid #C9A96E"></div>' + b.innerHTML + '</body></html>');
  w.document.close();
  setTimeout(function() { w.print(); }, 400);
}

/* === Loading Animation === */
function anim() {
  if (V !== 'loading') return;
  if (STEP < ST.length - 1) {
    STEP++;
    for (var i = 0; i < ST.length; i++) {
      var el = $('s' + i);
      if (!el) continue;
      el.className = 'ss' + (STEP > i ? ' ok' : STEP === i ? ' on' : '');
      var ic = el.querySelector('.si2');
      if (STEP > i) ic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>';
      else if (STEP === i) ic.innerHTML = '<div class="msp"></div>';
    }
    setTimeout(anim, 2500 + Math.random() * 2000);
  }
}

/* === Main Search Function — calls /api/ask === */
function go() {
  var inp = $('si');
  var q = TQ || (inp ? inp.value.trim() : '');
  TQ = '';
  if (!q) { if (LQ) q = LQ; else return; }
  LQ = q;
  V = 'loading';
  STEP = 0;
  R();
  setTimeout(anim, 1500);

  fetch('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q })
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    if (d.error) throw new Error(d.error);
    RES = {
      content: d.content || '',
      sources: d.sources || [],
      type: d.type || 'دراسة قانونية'
    };
    V = 'result';
    R();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  })
  .catch(function(e) {
    ERR = e.message || 'حدث خطأ';
    V = 'error';
    R();
  });
}

/* === Initialize === */
R();
