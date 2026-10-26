(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const docEl = document.documentElement;

  /* ── движение: токены, reduced-motion, замедление ── */
  const ui = {
    reduce: $('#mock-reduce'), slow: $('#mock-slow'), first: $('#mock-first'), fit: $('#mock-fitwin'),
  };
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  ui.reduce.checked = mq.matches;
  const reduced = () => ui.reduce.checked;
  const k = () => (ui.slow.checked ? 4 : 1);
  const cssVar = (n) => getComputedStyle(docEl).getPropertyValue(n).trim();
  const ms = (n) => parseFloat(cssVar(n)) * k();
  const px = (n) => parseFloat(cssVar(n));
  const syncMotion = () => {
    document.body.classList.toggle('mock-reduced', reduced());
    docEl.style.setProperty('--mock-k', k());
  };
  ui.reduce.onchange = syncMotion;
  ui.slow.onchange = syncMotion;
  mq.addEventListener('change', () => { ui.reduce.checked = mq.matches; syncMotion(); });
  syncMotion();

  /* ── окно: вписать в ширину ── */
  const frame = $('#mock-frame'), fitBox = $('#mock-fit');
  const fit = () => {
    const open = $('#mock-panel').dataset.collapsed !== 'true';
    const s = ui.fit.checked ? Math.min(1, (document.documentElement.clientWidth - 48 - (open ? 316 : 0)) / 1280) : 1;
    frame.style.transform = s < 1 ? `scale(${s})` : '';
    fitBox.style.width = 1280 * s + 'px';
    fitBox.style.height = 800 * s + 'px';
  };
  addEventListener('resize', fit);
  ui.fit.onchange = fit;
  fit();

  /* ── сцены из <template> ── */
  const SCENES = { setup: 'setup', fronts: 'scan-fronts', backs: 'scan-backs', flip: 'flip', merge: 'merge', editor: 'editor', editorSets: 'mismatch' };
  const tpl = (id) => $(`template[data-scene="${id}"]`).content;
  const screenMarkup = (key) => tpl(SCENES[key]).querySelector('.app > main').cloneNode(true);
  const overlayMarkup = (id) => tpl(id).querySelector('.modal-overlay').cloneNode(true);

  const root = $('#mock-root'), stack = $('#mock-stack');
  const state = {
    key: null, auto: false, docs: 'one', result: 'summary',
  };
  const HINT_KEY = 'duplexnt-mock:docs-hint-seen';
  ui.first.checked = !localStorage.getItem(HINT_KEY);
  ui.first.onchange = () => { if (ui.first.checked) localStorage.removeItem(HINT_KEY); else localStorage.setItem(HINT_KEY, '1'); };

  let timers = [];
  const later = (fn, t) => { const id = setTimeout(fn, t); timers.push(id); return id; };
  const every = (fn, t) => { const id = setInterval(fn, t); timers.push(id); return id; };
  const clearTimers = () => { timers.forEach((id) => { clearTimeout(id); clearInterval(id); }); timers = []; };

  /* ── 1. смена экранов: растворение (1a) ── */
  let cur = null, screenAnim = null;
  function show(key, opts = {}) {
    clearTimers();
    blanksArrive = null;
    $('#mock-blanks').disabled = true;
    modal = null;
    const el = document.createElement('div');
    el.className = 'app mock-screen';
    el.appendChild(screenMarkup(key));
    const prev = cur;
    if (screenAnim) screenAnim.finish();
    $$('.mock-screen', stack).forEach((s) => s !== prev && s.remove());
    stack.appendChild(el);
    cur = el;
    state.key = key;
    if (prev) {
      prev.inert = true; // уходящий экран ещё виден, но не принимает ввод
      screenAnim = el.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: reduced() ? ms('--duration-exit') : ms('--duration-screen'), easing: cssVar('--ease-standard'),
      });
      const a = screenAnim;
      a.onfinish = a.oncancel = () => { prev.remove(); if (screenAnim === a) screenAnim = null; };
      setTimeout(() => prev.remove(), ms('--duration-screen') + 100); // страховка, если вкладка в фоне и анимации стоят
    }
    SETUP[key](el, opts);
    syncPanel();
  }

  const SETUP = {
    setup(el) {
      $('.btn--primary', el).onclick = () => show('fronts', { ret: 'setup' });
      $('.device-row .btn--ghost', el).onclick = () => openModal('device', (ov) => {
        $$('.modal__footer .btn', ov).forEach((b) => (b.onclick = closeModal));
      });
      if (state.auto) later(() => show('fronts', { ret: 'setup' }), 1100);
    },
    fronts(el, opts) { scan(el, 'fronts', opts); },
    backs(el, opts) { scan(el, 'backs', opts); },
    flip(el, opts) {
      $('.btn--primary', el).onclick = () => show('backs', { ret: 'flip' });
      $('.btn--link', el).onclick = () => show('merge', { short: true, sc: 'noBacks' });
      if (opts.sc === 'noBacks') later(() => show('merge', { short: true, sc: 'noBacks' }), 1400);
      else if (state.auto) later(() => show('backs', { ret: 'flip' }), 1800);
    },
    merge(el, opts) { merge(el, opts); },
    editor(el, opts) { editor(el); if (opts.toast) later(() => toast(opts.toast), ms('--duration-screen')); },
    editorSets(el, opts) {
      state.auto = false;
      later(() => openModal('mismatch', (ov, box) => {
        if (opts.extra) {
          $('.modal__title', box).textContent = 'Лицевых сторон 6, оборотов — 7';
          $('.modal__subtitle', box).textContent = 'Скорее всего, один оборот отсканирован дважды или в лоток попал лишний лист. Документ пока не собран: лица и обороты лежат отдельными наборами в порядке будущего документа, ничего не удалено. Найдите лишний оборот и удалите его. Когда наборы уравняются, нажмите «Собрать документ».';
        }
        $('.modal__footer .btn', box).onclick = closeModal;
      }), ms('--duration-screen'));
    },
  };

  /* ── B-5: экран merge ── */
  const SC = {
    ok: { mode: 'ok', status: 'совпало пар: 6' },
    blanks: { mode: 'ok', status: 'совпало пар: 6', blanks: { after: 3000, found: 2 } },
    blanksLong: { mode: 'ok', status: 'совпало пар: 6', blanks: { after: Infinity, found: 2 } },
    short: { mode: 'short', warn: true, status: 'не сошлось: лицевых 6, оборотов 5 — документ соберёте в редакторе', next: 'editorSets' },
    extra: { mode: 'extra', warn: true, status: 'лишних оборотов: 1 — документ соберёте в редакторе', next: 'editorSets', extra: true },
    noBacks: { mode: 'fronts', status: 'обороты не нужны · страниц: 6', short: true },
    set: { mode: 'ok', set: true, status: 'набор Д1: совпало пар 3' },
  };
  let blanksArrive = null;
  function merge(el, opts) {
    const sc = SC[opts.sc || (opts.short ? 'noBacks' : opts.added ? 'set' : 'ok')];
    const main = $('main', el);
    main.setAttribute('aria-label', sc.set ? 'Сопоставляем лица и обороты набора' : 'Сопоставляем лица и обороты');
    main.innerHTML = `<div class="merge-screen__head">${sc.set ? '<div class="merge-screen__tag">НАБОР Д1</div>' : ''}<h1 class="merge-screen__title">${sc.set ? 'Сопоставляем лица и обороты набора' : sc.mode === 'fronts' ? 'Собираем лицевые стороны' : 'Сопоставляем лица и обороты'}</h1></div><div class="sort" aria-hidden="true"></div><p class="merge-screen__status${sc.warn ? ' merge-screen__status--warning' : ''}" role="status" aria-live="polite">${sc.warn ? '<span class="dot dot--warning" aria-hidden="true"></span>' : ''}<span class="merge-screen__main"></span><span class="merge-screen__tail"></span></p>`;
    $('.merge-screen__main', main).textContent = sc.status;
    const sortEl = $('.sort', main);
    Sort.mount(sortEl, 'b', { mode: sc.mode, still: reduced(), k: k() });
    const tail = $('.merge-screen__tail', main);
    const setTail = (t) => {
      tail.textContent = t;
      tail.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduced() ? 0 : ms('--duration-fast') });
    };
    let minDone = false, blanksDone = !sc.blanks;
    const leave = () => {
      if (!minDone || !blanksDone) return;
      $('#mock-blanks').disabled = true;
      blanksArrive = null;
      const n = sc.blanks?.found;
      show(sc.next || 'editor', { extra: sc.extra, toast: n ? `Документ собран: 6 листов — скрыто ${n} пустых оборота` : null });
    };
    if (sc.blanks) {
      setTail(' · ищем пустые обороты…');
      blanksArrive = () => { if (blanksDone) return; blanksDone = true; setTail(` · пустых оборотов: ${sc.blanks.found}`); leave(); };
      if (isFinite(sc.blanks.after)) later(blanksArrive, sc.blanks.after);
      else $('#mock-blanks').disabled = false;
    }
    later(() => { minDone = true; leave(); }, sc.short ? 1200 : 1600);
  }

  /* ── 2. экран scan и лента последних пяти ── */
  const FRONT_PAGES = ['01', '03', '05', '07', '09', '11'];
  const BACK_PAGES = ['12', '10', '08', '06', '04', '02'];
  function scan(el, pass, opts) {
    const ret = opts.ret || 'setup';
    const added = opts.added; // 'oneSided' | 'twoSided' | undefined
    const tag = $('.scan-screen__tag', el);
    if (added) {
      tag.textContent = added === 'oneSided' ? 'ДОБАВЛЯЕМ СТРАНИЦЫ' : pass === 'fronts' ? 'ДОБАВЛЯЕМ · ЛИЦА' : 'ДОБАВЛЯЕМ · ОБОРОТЫ';
      tag.style.background = 'var(--color-pass-3)';
    }
    const expected = opts.expected ?? (added ? 3 : 6);
    const total = opts.count ?? expected;
    const of = pass === 'backs' ? ` из ${expected}` : '';
    const counter = $('.scan-screen__counter', el);
    const strip = $('.strip', el);
    strip.innerHTML = '';
    counter.textContent = `Отсканировано 0${of}`;
    $('.scan-screen > .btn', el).onclick = () => show(ret);
    state.stop = () => show(ret);
    const pages = pass === 'fronts' ? FRONT_PAGES : BACK_PAGES;
    let n = opts.from ?? 0;
    for (let j = Math.max(0, n - 5); j < n; j++) {
      const li = document.createElement('li');
      li.className = 'strip__card';
      li.innerHTML = `<img class="strip__img" alt="Страница ${j + 1}" src="../reference/pages/page-${pages[j % 6]}.jpg">`;
      strip.appendChild(li);
    }
    counter.textContent = `Отсканировано ${n}${of}`;
    const tick = every(() => {
      n++;
      counter.textContent = `Отсканировано ${n}${of}`;
      stripPush(strip, `../reference/pages/page-${pages[(n - 1) % 6]}.jpg`, n);
      if (n < total) return;
      clearInterval(tick);
      later(() => {
        if (pass === 'backs') return show('merge', { added, sc: opts.sc });
        if (added === 'oneSided') return show('editor');
        show('flip', { added, sc: opts.sc });
      }, 520);
    }, 300);
  }

  // Положение карточки по раскладке + текущий сдвиг незаконченной анимации (не зависит от масштаба окна).
  const visualX = (c) => c.offsetLeft + new DOMMatrixReadOnly(getComputedStyle(c).transform).m41;

  function stripPush(strip, src, n) {
    const cards = $$('.strip__card:not(.strip__card--leaving)', strip);
    const before = new Map(cards.map((c) => [c, visualX(c)]));
    cards.forEach((c) => c.getAnimations().forEach((a) => a.cancel()));
    $$('.strip__card--leaving', strip).forEach((c) => c.remove());

    let leaving = null;
    if (cards.length >= 5) {
      leaving = cards[0];
      const left = before.get(leaving), top = leaving.offsetTop;
      leaving.classList.add('strip__card--leaving');
      leaving.style.left = left + 'px';
      leaving.style.top = top + 'px';
    }
    const li = document.createElement('li');
    li.className = 'strip__card strip__card--loading';
    li.innerHTML = `<img class="strip__img" alt="Страница ${n}" src="${src}"><span class="skeleton skeleton--cover" aria-hidden="true"></span>`;
    strip.appendChild(li);
    // скелетон → картинка: в приложении — по событию load; здесь имитация декодирования
    setTimeout(() => { li.classList.remove('strip__card--loading'); li.querySelector('.skeleton')?.remove(); }, 140);

    const d = ms('--duration-screen'), easing = cssVar('--ease-out');
    if (reduced()) {
      leaving?.remove();
      li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms('--duration-exit') });
      return;
    }
    li.animate([{ opacity: 0, transform: `translateX(${px('--distance-enter')}px)` }, { opacity: 1, transform: 'none' }], { duration: d, easing });
    for (const [c, x0] of before) {
      if (c === leaving) continue;
      const dx = x0 - c.offsetLeft;
      if (Math.abs(dx) > 0.5) c.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: d, easing });
    }
    if (leaving) {
      const a = leaving.animate([{ opacity: 0.32, transform: 'none' }, { opacity: 0, transform: `translateX(-${px('--distance-enter')}px)` }], { duration: ms('--duration-exit'), easing: cssVar('--ease-standard'), fill: 'forwards' });
      a.onfinish = () => leaving.remove();
    }
  }

  /* ── 3. редактор: выделение, превью, поворот (2a) ── */
  const DOCS_NOTE_ONE = 'Границы не отмечены: всё сохранится одним файлом. Чтобы разделить, наведите курсор на верх миниатюры и нажмите «+ Новый документ» — или выделите страницы подряд (Shift — диапазон, Ctrl — по одной) и нажмите «Выделить в документ».';
  let ed = null;

  function mergeDocs(el) {
    const [g1, g2] = $$('.doc-group', el);
    const ul = $('.thumbs', g1);
    $$('.thumb', g2).forEach((t) => ul.appendChild(t));
    g2.remove();
    $('.doc-group__count', g1).textContent = '12 стр.';
    const rm = $('.thumb__split--remove', el);
    if (rm) { rm.classList.remove('thumb__split--remove'); rm.textContent = '+ Новый документ'; rm.title = 'Начать новый документ с этой страницы'; }
    $$('.doc-list > li', el)[1].remove();
    $('.doc-list__meta', el).textContent = '12 стр. · стр. 1–12 набора';
    $('.inspector__meta', el).textContent = '1 документ';
    $('.inspector__note', el).textContent = DOCS_NOTE_ONE;
    $('.editor-screen__toolbar-right .btn--primary', el).textContent = 'Сохранить файл';
    $('.edits-bar', el)?.remove();
  }

  function editor(el) {
    if (state.docs === 'one') mergeDocs(el);
    state.auto = false;
    const thumbs = $$('.thumb', el);
    ed = {
      el, thumbs, cur: 0, sel: new Set([0]), anchor: 0,
      angle: thumbs.map(() => 0),
      back: thumbs.map((t) => $('.thumb__tag', t)?.textContent === 'об'),
      doc: thumbs.map((t) => $$('.doc-group', el).indexOf(t.closest('.doc-group'))),
      paper: $('.preview__paper', el),
    };
    thumbs.forEach((t, i) => t.addEventListener('click', (e) => {
      if (e.target.closest('.thumb__split')) return;
      select(i, e);
    }));
    const [prevBtn, nextBtn] = $$('.stage__statusbar > .btn--icon', el);
    prevBtn.onclick = () => ed.cur > 0 && select(ed.cur - 1, {});
    nextBtn.onclick = () => ed.cur < thumbs.length - 1 && select(ed.cur + 1, {});
    const [ccw, cw] = $$('.stage__tool', el);
    ccw.onclick = () => rotate(-90, [...ed.sel]);
    cw.onclick = () => rotate(90, [...ed.sel]);
    const flip = $('.rail__footer .toggle__input', el);
    flip.onchange = () => rotate(flip.checked ? 180 : -180, ed.back.map((b, i) => (b ? i : -1)).filter((i) => i >= 0));
    const det = $('.details-toggle', el);
    det.onclick = () => { const open = det.getAttribute('aria-expanded') !== 'true'; det.setAttribute('aria-expanded', open); $('.details', el).hidden = !open; };

    $('.editor-screen__add', el).onclick = () => openAdd();
    $('.editor-screen__toolbar-left .btn', el).onclick = () => openNewscan();
    $('.editor-screen__toolbar-right .btn--primary', el).onclick = () => openSave();
    renderSel(true);
    maybeHint(el);
  }

  addEventListener('keydown', (e) => edKeys(e));
  function edKeys(e) {
    if (!ed || state.key !== 'editor' || modal || e.target.closest('input')) return;
    if (e.key === 'ArrowRight' && ed.cur < ed.thumbs.length - 1) select(ed.cur + 1, e);
    if (e.key === 'ArrowLeft' && ed.cur > 0) select(ed.cur - 1, e);
  }

  function select(i, e) {
    const prev = ed.cur;
    if (e.shiftKey) {
      const [a, b] = [Math.min(ed.anchor, i), Math.max(ed.anchor, i)];
      ed.sel = new Set(Array.from({ length: b - a + 1 }, (_, j) => a + j));
    } else if (e.ctrlKey || e.metaKey) {
      ed.sel.has(i) && ed.sel.size > 1 ? ed.sel.delete(i) : ed.sel.add(i);
      ed.anchor = i;
    } else {
      ed.sel = new Set([i]);
      ed.anchor = i;
    }
    ed.cur = i;
    renderSel(prev !== i);
  }

  function renderSel(pageChanged) {
    const multi = ed.sel.size > 1;
    ed.thumbs.forEach((t, i) => {
      t.classList.toggle('thumb--selected', i === ed.cur);
      t.classList.toggle('thumb--in-selection', multi && ed.sel.has(i));
      t.setAttribute('aria-selected', ed.sel.has(i));
    });
    if (pageChanged) renderPreview();
  }

  function renderPreview() {
    const { el, cur, paper } = ed;
    const t = ed.thumbs[cur];
    paper.getAnimations().forEach((a) => a.cancel());
    const img = $('.preview__img', paper);
    img.src = $('.thumb__img', t).src;
    img.alt = `Страница ${cur + 1}`;
    const d = ed.doc[cur];
    paper.className = `preview__paper doc-tone--${d + 1}`;
    $('.preview__doc-start', paper)?.remove();
    const docStart = d > 0 && ed.doc[cur - 1] !== d;
    if (docStart) {
      paper.classList.add('preview__paper--doc-start');
      paper.insertAdjacentHTML('beforeend', `<span class="preview__doc-start">НАЧАЛО ДОКУМЕНТА ${d + 1}</span>`);
    }
    paperClasses(paper, ed.angle[cur]);
    $('.stage__counter', el).textContent = `${cur + 1} из ${ed.thumbs.length}`;
    const [p, n] = $$('.stage__statusbar > .btn--icon', el);
    p.setAttribute('aria-disabled', cur === 0);
    n.setAttribute('aria-disabled', cur === ed.thumbs.length - 1);
    const groups = $$('.doc-group', el);
    const g = groups[d];
    const inDoc = ed.doc.filter((x) => x === d).length;
    const pos = ed.doc.slice(0, cur + 1).filter((x) => x === d).length;
    const center = $('.editor-screen__toolbar-center', el);
    center.className = `editor-screen__toolbar-center doc-tone--${d + 1}`;
    $('.editor-screen__doc-title', el).textContent = $('.doc-group__name', g).value;
    $('.editor-screen__doc-pos', el).textContent = `документ ${d + 1} из ${groups.length} · стр. ${pos} из ${inDoc}`;
    $$('.doc-list__item', el).forEach((b, j) => (j === d ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current')));
    renderDetails();
  }

  function renderDetails() {
    const i = ed.cur, sheet = Math.floor(i / 2) + 1;
    $('.details-toggle__summary', ed.el).textContent = `стр. ${i + 1}`;
    $('.details__title', ed.el).textContent = `Стр. ${i + 1} — ${ed.back[i] ? 'оборот' : 'лицо'} листа ${sheet}`;
    const v = $$('.facts__value', $('.details', ed.el));
    v[0].textContent = `№${sheet}`;
    v[1].textContent = ed.back[i] ? 'оборот' : 'лицо';
    v[2].textContent = `${ed.angle[i]}°`;
  }

  const ANGLES = [90, 180, 270];
  function thumbClasses(t, a) { ANGLES.forEach((x) => t.classList.toggle(`thumb--angle-${x}`, a === x)); }
  function paperClasses(p, a) {
    ANGLES.forEach((x) => p.classList.toggle(`preview__paper--angle-${x}`, a === x));
    p.classList.toggle('preview__paper--landscape', a % 180 !== 0);
  }
  const thumbScale = (a) => (a % 180 ? 0.7071 : 1);
  // Остаток незаконченного поворота: на сколько градусов элемент ещё не довернулся.
  function residual(st) {
    if (!st || st.anim.playState !== 'running') return null;
    const p = st.anim.effect.getComputedTiming().progress ?? 1;
    st.anim.cancel();
    return p;
  }

  function turnThumb(t, a, delta) {
    const img = $('.thumb__img', t);
    const st = img._turn;
    const p = residual(st);
    const res = p == null ? 0 : st.rot0 * (1 - p);
    const sFrom = p == null ? thumbScale((a - delta + 360) % 360) : st.s0 + (st.s1 - st.s0) * p;
    thumbClasses(t, a);
    if (reduced()) return;
    const rot0 = res - delta, s1 = thumbScale(a);
    const anim = img.animate(
      [{ transform: `rotate(${a + rot0}deg) scale(${sFrom})` }, { transform: `rotate(${a}deg) scale(${s1})` }],
      { duration: ms('--duration-turn'), easing: cssVar('--ease-out') });
    img._turn = { anim, rot0, s0: sFrom, s1 };
  }

  // Превью: конечное положение — прежние классы угла; анимация — FLIP от прежнего вида.
  function turnPaper(paper, a, delta) {
    const st = paper._turn;
    const p = residual(st);
    const res = p == null ? 0 : st.rot0 * (1 - p);
    const sRes = p == null ? 1 : st.s0 + (1 - st.s0) * p;
    const before = Math.max(paper.offsetWidth, paper.offsetHeight) * sRes;
    paperClasses(paper, a);
    if (reduced()) return;
    const after = Math.max(paper.offsetWidth, paper.offsetHeight);
    const rot0 = res - delta, s0 = before / after;
    const anim = paper.animate(
      [{ transform: `rotate(${rot0}deg) scale(${s0})` }, { transform: 'none' }],
      { duration: ms('--duration-turn'), easing: cssVar('--ease-out') });
    paper._turn = { anim, rot0, s0 };
  }

  function rotate(delta, indices) {
    indices.forEach((i) => {
      ed.angle[i] = (((ed.angle[i] + delta) % 360) + 360) % 360;
      turnThumb(ed.thumbs[i], ed.angle[i], delta);
      if (i === ed.cur) turnPaper(ed.paper, ed.angle[i], delta);
    });
    renderDetails();
  }

  /* ── 5. подсказка про Ctrl/Shift ── */
  function maybeHint(el) {
    const note = $('.inspector__note', el);
    if (state.docs !== 'one' || !note || localStorage.getItem(HINT_KEY)) return;
    localStorage.setItem(HINT_KEY, '1'); // один раз на установку: засчитано, как только показали
    ui.first.checked = false;
    const stop = () => {
      note.classList.remove('inspector__note--attention');
      if (note.classList.contains('inspector__note--attention-static')) {
        note.classList.remove('inspector__note--attention-static');
        note.animate([{ background: cssVar('--color-bg-attention') }, { background: 'transparent' }], { duration: ms('--duration-exit') });
      }
    };
    const start = ms('--duration-screen') + 400 * k();
    if (reduced()) {
      later(() => note.classList.add('inspector__note--attention-static'), start);
      later(stop, start + parseFloat(cssVar('--duration-loop-long')) * k());
    } else {
      later(() => note.classList.add('inspector__note--attention'), start);
      note.addEventListener('animationend', stop, { once: true });
    }
    // человек уже взялся за ленту или навёл на подсказку — дальше не мигаем
    $('.rail', el).addEventListener('pointerdown', stop, { once: true });
    note.addEventListener('pointerenter', stop, { once: true });
  }

  /* ── 4. модалки: открытие, закрытие, высота ── */
  let modal = null;
  function openModal(id, setup) {
    const swapping = !!modal;
    if (modal) modal.ov.remove();
    const ov = overlayMarkup(id);
    cur.appendChild(ov);
    const box = $('.modal', ov);
    modal = { ov, box, id };
    const fast = ms('--duration-fast'), easing = cssVar('--ease-out');
    if (reduced()) {
      if (!swapping) ov.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms('--duration-exit') });
    } else {
      if (!swapping) ov.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fast, easing: cssVar('--ease-standard') });
      box.animate([{ opacity: 0, transform: `translateY(${px('--distance-rise')}px)` }, { opacity: 1, transform: 'none' }], { duration: ms('--duration-screen'), easing });
    }
    box.focus({ preventScroll: true });
    setup && setup(ov, box);
  }
  function closeModal() {
    const m = modal;
    modal = null;
    if (!m) return;
    m.ov.style.pointerEvents = 'none';
    const a = m.ov.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms('--duration-exit'), easing: cssVar('--ease-standard'), fill: 'forwards' });
    a.onfinish = () => m.ov.remove();
  }
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && modal.box.getAttribute('aria-busy') !== 'true') closeModal();
  });

  // Высота модалки при смене содержимого: замер до и после, анимация height; новое проявляется.
  function morph(box, mutate) {
    const h0 = box.offsetHeight;
    box._morph?.cancel();
    const added = mutate() || [];
    const h1 = box.offsetHeight;
    if (reduced()) { added.forEach((n) => n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms('--duration-exit') })); return; }
    if (Math.abs(h1 - h0) > 1) {
      box._morph = box.animate([{ height: h0 + 'px' }, { height: h1 + 'px' }], { duration: ms('--duration-base'), easing: cssVar('--ease-out') });
    }
    added.forEach((n) => n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms('--duration-fast'), delay: ms('--duration-fast') / 3, easing: cssVar('--ease-standard'), fill: 'backwards' }));
  }

  /* — save — */
  const FOLDER = 'Сканы';
  const ERR = 'Не удалось записать файл. Проверьте, что папка доступна для записи, а на диске хватает места.';
  const fileRow = (tone, name, pages) => `<li class="save-file doc-tone--${tone}"><span class="doc-badge doc-badge--small" aria-hidden="true">${tone}</span><input class="save-file__name" placeholder="Документ ${tone}" maxlength="200" aria-label="Имя файла ${tone}" type="text" value="${name}"><span class="save-file__ext">.pdf</span><span class="save-file__meta">${pages} стр.</span></li>`;
  const plural = (n) => (n === 1 ? 'файл' : n < 5 ? 'файла' : 'файлов');

  function openSave() {
    openModal('save', (ov, box) => {
      const two = state.docs === 'two';
      let mode = two ? 'separate' : 'single';
      const [sep, one] = $$('.save-mode', box);
      const title = $('.modal__title', box);
      const list = $('.save-files', box);
      const kicker = $('#save-files-kicker', box);
      const factFiles = $('.facts__value', box);
      const status = $('.modal__status', box);
      const [ghost, primary] = $$('.modal__footer .btn', box);
      const docNames = $$('.doc-group__name', cur).map((i) => i.value);
      const files = () => (mode === 'separate' ? docNames.map((n, i) => [i + 1, n, 6]) : [[1, two ? 'Скан 2026-10-26' : docNames[0], 12]]);
      const label = () => (files().length === 1 ? 'Сохранить файл' : `Сохранить ${files().length} ${plural(files().length)}`);
      const renderForm = () => {
        sep.setAttribute('aria-checked', mode === 'separate');
        one.setAttribute('aria-checked', mode === 'single');
        list.innerHTML = files().map((f) => fileRow(...f)).join('');
        kicker.textContent = `ФАЙЛЫ · ${files().length}`;
        factFiles.textContent = files().length;
        title.textContent = primary.textContent = label();
        return [...list.children];
      };
      if (!two) { $('.save-mode__hint', sep).textContent = 'границы ещё не отмечены'; sep.setAttribute('aria-disabled', 'true'); }
      renderForm();
      sep.onclick = () => {
        if (!two) return toast('Сначала отметьте границы между документами');
        if (mode !== 'separate') { mode = 'separate'; morph(box, renderForm); }
      };
      one.onclick = () => { if (mode !== 'single') { mode = 'single'; morph(box, renderForm); } };
      ghost.onclick = closeModal;

      const setBusy = (busy) => {
        box.setAttribute('aria-busy', busy);
        ghost.disabled = primary.disabled = busy;
        if (busy) { status.textContent = 'Записываем файлы…'; primary.textContent = 'Сохраняем…'; }
      };
      const lockForm = () => $$('.save-mode, .save-file__name, .save-folder .btn', box).forEach((n) => (n.disabled = true));
      const savedToast = (names) => toast(names.length === 1 ? `Сохранено: ${names[0]} → ${FOLDER}` : `Сохранено ${names.length} ${plural(names.length)} → ${FOLDER}`, 'Открыть папку', 6000);

      const write = () => {
        setBusy(true);
        setTimeout(() => {
          if (!modal || modal.box !== box) return;
          const f = files();
          if (state.result === 'clean') { closeModal(); return savedToast(f.map((x) => x[1] + '.pdf')); }
          // ИТОГ: первый — переименован ядром, второй (если есть) — не записан
          morph(box, () => {
            setBusy(false);
            lockForm();
            const rows = f.map(([, name], i) => (i === 0
              ? `<li class="save-result__row"><span class="save-result__icon" aria-hidden="true">✓</span><span class="save-result__name">${name} (2).pdf<span class="save-result__note">имя было занято — добавлен номер</span></span></li>`
              : `<li class="save-result__row save-result__row--failed"><span class="save-result__icon" aria-hidden="true">✕</span><span class="save-result__name">${name}.pdf<span class="save-result__note">${ERR}</span></span></li>`)).join('');
            const sec = document.createElement('div');
            sec.className = 'modal__section';
            sec.innerHTML = `<h3 class="kicker">ИТОГ</h3><ul class="save-result">${rows}</ul>`;
            $('.modal__body', box).appendChild(sec);
            const failed = f.length > 1;
            status.textContent = failed ? `Записано 1 из ${f.length}.` : '';
            ghost.textContent = 'Закрыть';
            ghost.style.display = failed ? '' : 'none';
            primary.textContent = failed ? 'Повторить неудавшиеся' : 'Готово';
            primary.onclick = failed ? retry : () => { closeModal(); savedToast([`${f[0][1]} (2).pdf`]); };
            requestAnimationFrame(() => { const b = $('.modal__body', box); b.scrollTop = b.scrollHeight; });
            return [sec];
          });
        }, 900);
      };
      const retry = () => {
        setBusy(true);
        setTimeout(() => { if (modal && modal.box === box) { closeModal(); savedToast(files().map((x, i) => (i === 0 ? `${x[1]} (2).pdf` : `${x[1]}.pdf`))); } }, 700);
      };
      primary.onclick = write;
    });
  }

  function openNewscan() {
    openModal('newscan', (ov, box) => {
      const [close, save] = $$('.choice', box);
      close.onclick = () => show('setup');
      save.onclick = () => openSave();
      $('.modal__footer .btn', box).onclick = closeModal;
    });
  }

  function openAdd() {
    openModal('add', (ov, box) => {
      const cards = $$('.radio-card', box);
      let kind = 'twoSided';
      cards.forEach((c) => (c.onclick = () => {
        kind = c.dataset.value;
        cards.forEach((x) => { const on = x === c; x.classList.toggle('radio-card--selected', on); x.setAttribute('aria-checked', on); });
        $('.add-modal__summary', box).textContent = `${kind === 'twoSided' ? 'Двустороннее' : 'Одностороннее'} · в конец документа «Договор аренды», после стр. 6`;
      }));
      const [cancel, go] = $$('.modal__footer .btn', box);
      cancel.onclick = closeModal;
      go.onclick = () => show('fronts', { ret: 'editor', added: kind });
    });
  }

  /* — тост — */
  let toastEl = null, toastTimer = null;
  function toast(text, action, dur = 2600) {
    if (toastEl) toastEl.remove(); // новый гасит предыдущий сразу
    clearTimeout(toastTimer);
    const t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.innerHTML = '<span class="toast__text"></span>';
    $('.toast__text', t).textContent = text;
    if (action) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'toast__action'; b.textContent = action;
      b.onclick = () => dismiss(t);
      t.appendChild(b);
    }
    root.appendChild(t);
    toastEl = t;
    if (reduced()) t.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms('--duration-exit') });
    else t.animate([{ opacity: 0, transform: `translateX(-50%) translateY(${px('--distance-rise')}px)` }, { opacity: 1, transform: 'translateX(-50%)' }], { duration: ms('--duration-screen'), easing: cssVar('--ease-out') });
    toastTimer = setTimeout(() => dismiss(t), dur);
  }
  function dismiss(t) {
    if (toastEl === t) toastEl = null;
    const a = t.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms('--duration-exit'), easing: cssVar('--ease-standard'), fill: 'forwards' });
    a.onfinish = () => t.remove();
  }

  /* ── панель сценариев ── */
  const NAMES = { setup: 'setup', fronts: 'scan · лица', backs: 'scan · обороты', flip: 'flip', merge: 'merge', editor: 'editor', editorSets: 'editor · наборы' };
  function syncPanel() {
    $('#mock-screen-name').textContent = NAMES[state.key];
    $$('#mock-jump .segment').forEach((b) => b.classList.toggle('segment--selected', b.dataset.jump === state.key));
    $('#mock-save').disabled = state.key !== 'editor';
    if (location.hash.slice(1) !== state.key) history.replaceState(null, '', '#' + state.key);
  }
  const segPick = (sel, attr, fn) => $$(`${sel} .segment`).forEach((b) => (b.onclick = () => {
    $$(`${sel} .segment`).forEach((x) => x.classList.toggle('segment--selected', x === b));
    fn(b.dataset[attr]);
  }));
  segPick('#mock-docs', 'docs', (v) => { state.docs = v; if (state.key === 'editor') show('editor'); });
  segPick('#mock-result', 'result', (v) => (state.result = v));
  $$('#mock-jump .segment').forEach((b) => (b.onclick = () => { state.auto = false; show(b.dataset.jump, { ret: b.dataset.jump === 'backs' ? 'flip' : 'setup' }); }));
  $('#mock-run').onclick = () => { state.auto = true; show('setup'); };
  $('#mock-stop').onclick = () => { state.auto = false; if (state.key === 'fronts' || state.key === 'backs') state.stop(); };
  $('#mock-save').onclick = () => state.key === 'editor' && !modal && openSave();
  $('#mock-toast').onclick = () => toast('Страница удалена — Ctrl+Z вернёт');
  $('#mock-blanks').onclick = () => blanksArrive && blanksArrive();
  $$('#mock-sc .segment').forEach((b) => (b.onclick = () => {
    state.auto = false;
    $$('#mock-sc .segment').forEach((x) => x.classList.toggle('segment--selected', x === b));
    const sc = b.dataset.sc;
    if (sc === 'noBacks') return show('fronts', { ret: 'setup', from: 4, sc });
    if (sc === 'set') return show('backs', { ret: 'editor', added: 'twoSided', from: 1, sc });
    show('backs', { ret: 'flip', from: 4, count: sc === 'short' ? 5 : sc === 'extra' ? 7 : 6, sc });
  }));
  const panel = $('#mock-panel');
  $('#mock-panel-toggle').onclick = (e) => {
    const c = panel.dataset.collapsed === 'true';
    panel.dataset.collapsed = !c;
    e.currentTarget.setAttribute('aria-expanded', c);
    fit();
  };

  const start = location.hash.slice(1);
  show(SCENES[start] ? start : 'setup');
})();
