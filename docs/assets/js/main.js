/* Duplexn't — поведение лендинга: языки, карусель, роадмап, история версий, пасхалка. */
(function () {
  'use strict';

  var EN = {
  "egg": [
    "There’s nothing here.",
    "Seriously. It’s empty.",
    "The elves ask you to stop poking.",
    "Well. Now you’ve done it."
  ],
  "expandAll": "Expand all",
  "collapseAll": "Collapse all",
  "olderShow": "Show earlier versions",
  "olderHide": "Hide earlier versions",
  "captions": [
    "Editor: pages, documents, assembly check",
    "Setup: scanner and settings"
  ]
};
  var LOCALES = window.DUPLEXNT_LOCALES || {};
  var root = document.documentElement;
  var lang = window.DUPLEXNT_LANG === 'ru' && LOCALES.ru ? 'ru' : 'en';

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function dict() { return lang === 'en' ? null : LOCALES[lang]; }

  /* ---------- строки для JS ---------- */
  function str(name) {
    var d = dict();
    return d && d['js.' + name] != null ? d['js.' + name] : EN[name];
  }
  function countText(n) {
    if (lang === 'ru') return n + ' ' + (str('countForms') || ['шт.'])[0];
    return n + (n === 1 ? ' item' : ' items');
  }

  /* ---------- перевод разметки ---------- */
  var originals = new Map();   // элемент → английский оригинал (для обратного переключения)
  function remember(el, key, value) {
    var o = originals.get(el);
    if (!o) { o = {}; originals.set(el, o); }
    if (!(key in o)) o[key] = value;
    return o[key];
  }
  function applyLang() {
    var d = dict();
    $$('[data-i18n]').forEach(function (el) {
      var en = remember(el, 'text', el.textContent);
      var k = el.getAttribute('data-i18n');
      el.textContent = d && d[k] != null ? d[k] : en;
    });
    $$('[data-i18n-html]').forEach(function (el) {
      var en = remember(el, 'html', el.innerHTML);
      var k = el.getAttribute('data-i18n-html');
      el.innerHTML = d && d[k] != null ? d[k] : en;
    });
    $$('[data-i18n-attr]').forEach(function (el) {
      el.getAttribute('data-i18n-attr').split(';').forEach(function (pair) {
        var p = pair.split(':'); if (p.length < 2) return;
        var name = p[0].trim(), k = p.slice(1).join(':').trim();
        var en = remember(el, '@' + name, el.getAttribute(name));
        el.setAttribute(name, d && d[k] != null ? d[k] : en);
      });
    });
    var title = remember(document, 'title', document.title);
    document.title = d && d['meta.title'] ? d['meta.title'] : title;
    var meta = $('meta[name="description"]');
    if (meta) {
      var desc = remember(meta, 'content', meta.getAttribute('content'));
      meta.setAttribute('content', d && d['meta.description'] ? d['meta.description'] : desc);
    }
    root.lang = lang;

    // переключатель
    [['en', $('#lang-en')], ['ru', $('#lang-ru')]].forEach(function (x) {
      if (!x[1]) return;
      var on = x[0] === lang;
      x[1].setAttribute('aria-pressed', on ? 'true' : 'false');
      x[1].style.color = on ? '#1c1a16' : '#8b857a';
      x[1].style.textDecoration = on ? 'underline' : 'none';
    });

    // то, что пишет сам скрипт
    $$('.phase-count').forEach(function (el) { el.textContent = countText(+el.getAttribute('data-n')); });
    updateCaption();
    updateRoadmapAll();
    updateOlder();
    if (eggStep > 0 && eggStep <= str('egg').length) eggMsg.textContent = str('egg')[eggStep - 1];
  }
  function setLang(l) {
    lang = l === 'ru' && LOCALES.ru ? 'ru' : 'en';
    try { localStorage.setItem('lang', lang); } catch (e) {}
    if (/[?&]lang=/.test(location.search) && history.replaceState) {
      history.replaceState(null, '', location.pathname + location.search.replace(/([?&])lang=[^&]*&?/, '$1').replace(/[?&]$/, '') + location.hash);
    }
    applyLang();
  }

  /* ---------- карусель ---------- */
  var slides = $$('[data-slide]'), dots = $$('[data-dot]'), slide = 0, paused = false;
  var SLIDE_MS = 5000;
  function updateCaption() {
    var caps = lang === 'ru' && LOCALES.ru && LOCALES.ru['js.captions'] ? LOCALES.ru['js.captions'] : EN.captions;
    var cap = $('#slide-caption');
    if (cap) cap.textContent = caps[slide] || '';
  }
  function goSlide(i) {
    var n = slides.length; if (!n) return;
    slide = (i + n) % n;
    slides.forEach(function (img, k) {
      img.style.opacity = k === slide ? '1' : '0';
      img.setAttribute('aria-hidden', k === slide ? 'false' : 'true');
    });
    dots.forEach(function (d, k) {
      d.style.width = k === slide ? '22px' : '6px';
      d.style.background = k === slide ? '#1c1a16' : 'rgba(28,26,22,.25)';
    });
    updateCaption();
  }
  var timer = null;
  function restart() {
    clearInterval(timer);
    if (slides.length < 2) return;
    timer = setInterval(function () { if (!paused) goSlide(slide + 1); }, SLIDE_MS);
  }
  dots.forEach(function (d) { d.addEventListener('click', function () { goSlide(+d.getAttribute('data-dot')); restart(); }); });
  var prev = $('#slide-prev'), next = $('#slide-next'), hero = $('#hero-carousel');
  if (prev) prev.addEventListener('click', function () { goSlide(slide - 1); restart(); });
  if (next) next.addEventListener('click', function () { goSlide(slide + 1); restart(); });
  if (hero) {
    hero.addEventListener('mouseenter', function () { paused = true; });
    hero.addEventListener('mouseleave', function () { paused = false; });
  }

  /* ---------- раскрывашки ---------- */
  function setPanel(panel, open) {
    panel.style.gridTemplateRows = open ? '1fr' : '0fr';
    panel.style.opacity = open ? '1' : '0';
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
  }
  function setArrow(btn, open, label) {
    var a = btn.querySelector('span');
    if (a) a.style.transform = 'translateY(' + (open ? 2 : -2) + 'px) rotate(' + (open ? 225 : 45) + 'deg)';
    btn.setAttribute('aria-label', label); btn.setAttribute('title', label);
  }

  // роадмап
  var phases = $$('[data-phase]');
  function phaseOpen(li) { return li.querySelector('.phase-toggle').getAttribute('aria-expanded') === 'true'; }
  function setPhase(li, open) {
    li.querySelector('.phase-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
    li.querySelector('.phase-chev').textContent = open ? '−' : '+';
    setPanel(li.querySelector('.phase-panel'), open);
  }
  var allBtn = $('#roadmap-toggle-all');
  function updateRoadmapAll() {
    if (!allBtn) return;
    var all = phases.length && phases.every(phaseOpen);
    setArrow(allBtn, all, all ? str('collapseAll') : str('expandAll'));
  }
  phases.forEach(function (li) {
    li.querySelector('.phase-toggle').addEventListener('click', function () { setPhase(li, !phaseOpen(li)); updateRoadmapAll(); });
  });
  if (allBtn) allBtn.addEventListener('click', function () {
    var all = phases.every(phaseOpen);
    phases.forEach(function (li) { setPhase(li, !all); });
    updateRoadmapAll();
  });

  // история версий
  var olderBtn = $('#older-toggle'), olderPanel = $('#changelog-older'), olderOpen = false;
  function updateOlder() {
    if (!olderBtn || !olderPanel) return;
    setPanel(olderPanel, olderOpen);
    olderBtn.setAttribute('aria-expanded', olderOpen ? 'true' : 'false');
    setArrow(olderBtn, olderOpen, olderOpen ? str('olderHide') : str('olderShow'));
  }
  if (olderBtn) olderBtn.addEventListener('click', function () { olderOpen = !olderOpen; updateOlder(); });

  /* ---------- пасхалка: клик по пустому месту тёмного блока ----------
     Реплики 1–4; на 4-й блок «срывается с гвоздя», 5-й клик молча возвращает его, дальше по кругу. */
  var egg = $('#egg'), eggMsg = $('#egg-msg'), eggStep = 0, eggTimer = null;
  if (egg && eggMsg) egg.addEventListener('click', function (e) {
    if (e.target !== egg) return;
    var lines = str('egg');
    eggStep = eggStep % (lines.length + 1) + 1;
    clearTimeout(eggTimer);
    var fall = eggStep === lines.length;
    egg.style.transition = fall ? 'transform 1.1s cubic-bezier(.3,1.9,.45,1)' : 'transform .7s cubic-bezier(.3,.7,.2,1)';
    egg.style.transform = 'rotate(' + (fall ? 6 : 0) + 'deg)';
    if (eggStep <= lines.length) {
      eggMsg.textContent = lines[eggStep - 1];
      eggMsg.style.opacity = '1'; eggMsg.style.transform = 'translateY(0)';
      eggTimer = setTimeout(function () { eggMsg.style.opacity = '0'; eggMsg.style.transform = 'translateY(-4px)'; }, 2600);
    } else {
      eggMsg.style.opacity = '0'; eggMsg.style.transform = 'translateY(-4px)';
    }
  });

  /* ---------- старт ---------- */
  var en = $('#lang-en'), ru = $('#lang-ru');
  if (en) en.addEventListener('click', function () { setLang('en'); });
  if (ru) ru.addEventListener('click', function () { setLang('ru'); });
  applyLang();
  root.classList.remove('i18n-pending');
  restart();
})();
