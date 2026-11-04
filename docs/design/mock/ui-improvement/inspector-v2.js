// Мок M6 «Выравнивание» — поведение. Только мок: в handoff уходит поведение словами.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const K = () => (document.body.classList.contains('st-slow') ? 4 : 1);
  const reduced = () => document.body.classList.contains('st-reduced') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const plural = (n, one, few, many) => {
    const a = n % 10, b = n % 100;
    return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
  };
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  // — глифы —
  const GLYPH = {
    level: 'M0.6 1H9.4M0.6 4.5H9.4M0.6 8H9.4',
    undone: 'M0.6 2.8Q2.8 1 5 1.9T9.4 0.7M0.6 6Q2.8 4.2 5 5.1T9.4 3.9M0.6 9.2Q2.8 7.4 5 8.3T9.4 7.1',
  };
  const glyph = (g) => `<svg class="straight-glyph" viewBox="0 0 10 9" aria-hidden="true"><path d="${GLYPH[g]}" /></svg>`;
  const phase = () => `-${Math.round(performance.now() % (1200 * K()))}ms`;
  const dots = () => '<i></i><i></i><i></i>';

  // — тексты —
  const REASON = { measure: 'не по чему мерить', nohelp: 'коррекция не помогла', disk: 'мало места на диске', fail: 'сбой коррекции' };
  const SHORT = { measure: 'не по чему мерить', nohelp: 'не помогло', disk: 'мало места на диске', fail: 'сбой' };
  const TITLE = {
    straightened: 'Выровнено — исходный скан цел',
    kept: 'Оригинал — по вашему выбору',
    measure: 'Не выровнено: не по чему мерить',
    nohelp: 'Не выровнено: коррекция не помогла',
    disk: 'Не выровнено: мало места на диске — приложение попробует снова при следующем запуске',
    fail: 'Не выровнено: сбой коррекции — приложение попробует снова при следующем запуске',
  };
  const NOTE = {
    straightened: 'Строки на странице шли веером — приложение выровняло их. Исходный скан цел.',
    kept: 'Страница оставлена как со сканера — по вашему выбору. Выровненный вид не потерян: его можно вернуть.',
    measure: 'Приложение не нашло, по чему мерить наклон, — страница оставлена как есть.',
    nohelp: 'Выравнивание не сделало страницу ровнее — она оставлена как есть.',
    disk: 'Не хватило места на диске — страница оставлена как есть. Освободите место: при следующем запуске приложение попробует снова.',
    fail: 'Выровнять не получилось из-за сбоя — страница оставлена как есть. При следующем запуске приложение попробует снова.',
    pending: 'Приложение проверяет, ровно ли легли строки. Пока показан скан как есть; сохранение подождёт — делать ничего не нужно.',
  };
  const FACT = {
    straightened: 'выровнена', kept: 'оригинал — ваш выбор', level: 'ровная', pending: 'идёт…',
    measure: 'не по чему мерить', nohelp: 'не помогло', disk: 'отложено — мало места', fail: 'отложено — сбой',
  };

  // — фикстура: 12 листов, 24 страницы, 2 пустых оборота помечены —
  const FIX = {
    1: ['straightened'], 2: ['straightened'], 5: ['straightened'], 9: ['straightened'], 14: ['straightened'], 17: ['straightened'], 21: ['straightened'],
    4: ['unmeasurable', 'measure'], 16: ['unmeasurable', 'measure'], 8: ['unmeasurable', 'nohelp'],
    7: ['deferred', 'disk'], 19: ['deferred', 'disk'], 10: ['deferred', 'fail'], 12: [null], 24: [null],
  };
  const DOCS = ['Договор аренды', 'Приложение 1'];
  function makePages() {
    const a = [];
    for (let i = 1; i <= 24; i++) {
      const blank = i === 12 || i === 24;
      const f = FIX[i] || ['level'];
      a.push({
        id: 'p' + i, sheet: Math.ceil(i / 2), back: i % 2 === 0, blank, doc: i <= 12 ? 0 : 1, added: null,
        img: blank ? 'blank' : 'page-' + String(((i - 1) % 12) + 1).padStart(2, '0'),
        skew: i % 3 === 0 ? 'r' : 'l', origSkew: f[0] !== 'level' && f[0] !== null,
        st: f[0], reason: f[1] || null, fin: { st: f[0], reason: f[1] || null },
      });
    }
    return a;
  }

  const S = {
    screen: 'editor', mode: 'on', pages: makePages(), cur: 0, sel: new Set([0]), anchor: 0, details: true,
    hist: [], fut: [], keptMark: false, modal: null, batch: null, timer: null, batchTotal: 0,
    setup: { blank: 'hide', straight: 'on', online: true }, toastTimer: null, scene: 'done',
  };
  const P = () => S.pages;
  const curP = () => S.pages[S.cur];
  const vst = (p) => (S.mode === 'off' ? null : p.st);
  const skewCls = (p) => (p.origSkew && vst(p) !== 'straightened' ? 'st-skew-' + p.skew : '');
  const titleFor = (p) => (p.st === 'straightened' || p.st === 'kept' ? TITLE[p.st] : TITLE[p.reason]);
  const counts = () => {
    const c = { straightened: 0, kept: 0, level: 0, pending: 0, undone: 0, measure: 0, nohelp: 0, disk: 0, fail: 0 };
    if (S.mode === 'off') return c;
    P().forEach((p) => {
      if (!p.st) return;
      if (p.st === 'unmeasurable' || p.st === 'deferred') { c.undone++; c[p.reason]++; } else c[p.st]++;
    });
    return c;
  };

  // — экраны —
  const stack = $('#st-stack');
  function mount(html, name, animate = true) {
    const old = $$('.st-screen', stack);
    const el = document.createElement('div');
    el.className = 'st-screen' + (animate && old.length ? ' st-screen--in' : '');
    el.innerHTML = html;
    stack.appendChild(el);
    setTimeout(() => old.forEach((o) => o.remove()), animate ? 180 * K() : 0);
    S.screen = name;
    $('#st-screen-name').textContent = name;
    $$('#st-jump .segment').forEach((b) => b.classList.toggle('segment--selected', b.dataset.jump === (name === 'merge' ? 'merge' : name)));
    return el;
  }

  // ───────── setup ─────────
  function segs(label, key, items, disabled) {
    return `<div class="param-row"><div class="param-row__label">${label}</div><div class="segments" role="radiogroup" aria-label="${label}"${disabled ? ' aria-disabled="true"' : ''} data-key="${key}">${items
      .map(([v, t, title, sel]) => `<button type="button" role="radio" aria-checked="${sel}" data-value="${v}" class="segment${sel ? ' segment--selected' : ''}"${title ? ` title="${esc(title)}"` : ''}${disabled ? ' disabled' : ''}>${t}</button>`)
      .join('')}</div></div>`;
  }
  const FREEZE = ' Режим запоминается при запуске сканирования и до его конца не меняется: новый выбор подействует со следующего сканирования.';
  function setupHTML() {
    const u = S.setup, off = !u.online;
    const device = off
      ? '<div class="device-row"><div class="device-row__name device-row__name--empty">Сканер не подключён</div><span class="device-row__spacer"></span><button type="button" class="btn btn--primary btn--small">+ Добавить сканер</button></div>'
      : '<div class="device-row"><div class="device-row__name">ScanPro 200</div><div class="device-row__status"><span class="dot dot--ready" aria-hidden="true"></span><span class="device-row__status-text">готов</span></div><span class="device-row__spacer"></span><button type="button" class="btn btn--ghost">Сменить</button></div>';
    return `<div class="app"><div class="app__screen"><main class="setup-screen"><section class="setup-screen__column"><header class="setup-screen__intro"><div class="kicker">НОВОЕ СКАНИРОВАНИЕ</div><h1 class="setup-screen__title">Сканируем обе стороны в два прохода</h1><p class="setup-screen__lead">Сначала лицевые стороны всех листов. Потом вы развернёте их на 180° — все разом, не переворачивая — и приложение само сопоставит обороты с лицами.</p></header><div class="params">${device}${segs('Цвет', 'color', [['g', 'Оттенки серого', '', true]], off)}${segs('Разрешение', 'dpi', [['300', '300 dpi', 'обычный текст', true]], off)}${segs('Размер листа', 'size', [['A4', 'A4', '210×297 мм', true]], off)}${segs('Пустые обороты', 'blank', [
      ['hide', 'Скрывать', 'не попадут в файл', u.blank === 'hide'], ['mark', 'Помечать', 'останутся, но с меткой', u.blank === 'mark'], ['keep', 'Оставлять', 'сохранить всё как есть', u.blank === 'keep']])}${segs('Выравнивание', 'straight', [
      ['on', 'Выравнивать', 'косые страницы выпрямятся сами — исходные сканы целы.' + FREEZE, u.straight === 'on'], ['off', 'Не трогать', 'страницы останутся как со сканера.' + FREEZE, u.straight === 'off']])}<div class="params__footer"><button type="button" class="btn btn--ghost" data-act="reset">Сбросить параметры</button></div></div><div class="setup-screen__launch"><button type="button" class="btn btn--primary btn--large" data-act="launch">Сканировать лицевые стороны</button><p class="setup-screen__hint">Положите листы в лоток лицом вверх, первая страница сверху</p></div></section><aside class="setup-screen__aside" aria-label="КАК ЭТО РАБОТАЕТ"><div class="kicker">КАК ЭТО РАБОТАЕТ</div><ol class="howto"><li class="howto__step"><span class="howto__num" aria-hidden="true">1</span><span class="howto__body"><span class="howto__title">Лицевые стороны</span><span class="howto__text">Листы лицом вверх, первая страница сверху</span></span></li><li class="howto__step"><span class="howto__num" aria-hidden="true">2</span><span class="howto__body"><span class="howto__title">Разворот на 180°</span><span class="howto__text">Все листы разом, не переворачивая</span></span></li><li class="howto__step"><span class="howto__num" aria-hidden="true">3</span><span class="howto__body"><span class="howto__title">Обратная сторона</span><span class="howto__text">Приложение знает, что обороты идут в обратном порядке</span></span></li><li class="howto__step"><span class="howto__num" aria-hidden="true">4</span><span class="howto__body"><span class="howto__title">Проверка и сохранение</span><span class="howto__text">Порядок соберётся сам — проверьте его и сохраните документ</span></span></li></ol></aside></main></div></div>`;
  }
  function showSetup(animate = true) {
    stopBatch();
    const el = mount(setupHTML(), 'setup', animate);
    bindSetup(el);
  }
  function bindSetup(el) {
    el.addEventListener('click', (e) => {
      const seg = e.target.closest('.segment');
      if (seg && !seg.disabled) {
        const key = seg.parentElement.dataset.key;
        if (key === 'blank' || key === 'straight') { S.setup[key] = seg.dataset.value; rerenderSetup(); }
        return;
      }
      const a = e.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'reset') { S.setup.blank = 'hide'; S.setup.straight = 'on'; rerenderSetup(); }
      if (a.dataset.act === 'launch') { setMode(S.setup.straight); runMerge(); }
    });
  }
  function rerenderSetup() {
    const scr = $('.st-screen:last-child', stack);
    scr.innerHTML = setupHTML();
  }

  // ───────── merge ─────────
  const SORT = $$('.sort__sheet', document).length ? '' : '<div class="sort" aria-hidden="true">' + ['front f1', 'front f2', 'front f3', 'back b1', 'back b2', 'back b3'].map((c) => { const [s, n] = c.split(' '); return `<span class="sort__sheet sort__sheet--${s} sort__sheet--${n}"><span class="sort__line"></span><span class="sort__line"></span><span class="sort__line"></span></span>`; }).join('') + '</div>';
  function runMerge() {
    stopBatch();
    resetPages();
    const on = S.mode === 'on';
    if (on) P().forEach((p) => { if (p.fin.st) p.st = 'pending'; });
    S.batchTotal = counts().pending;
    const el = mount(`<div class="app"><main class="merge-screen" tabindex="-1" aria-label="Сопоставляем лица и обороты"><div class="merge-screen__head"><h1 class="merge-screen__title">Сопоставляем лица и обороты</h1></div>${SORT}<p class="merge-screen__status" role="status" aria-live="polite"><span class="merge-screen__main">совпало пар: 12</span><span class="merge-screen__tail st-tail-static"> · пустых оборотов: 2</span>${on ? `<span class="merge-screen__tail st-tail-static" id="st-mtail"></span>` : ''}</p></main></div>`, 'merge');
    const tail = $('#st-mtail', el);
    const t0 = performance.now();
    const paintTail = () => { if (tail) tail.textContent = ` · выравнивание: ещё ${counts().pending} стр.`; };
    paintTail();
    if (tail) { tail.classList.add('st-tail-in'); }
    const leave = () => {
      const wait = Math.max(0, 1600 * K() - (performance.now() - t0));
      S.timer = setTimeout(() => showEditor(), wait);
    };
    if (!on) return leave();
    startBatch(null, 380, () => paintTail(), () => {
      const c = counts();
      tail.classList.remove('st-tail-in'); void tail.offsetWidth;
      tail.textContent = ` · выровнено: ${c.straightened} стр.`;
      tail.classList.add('st-tail-in');
      S.timer = setTimeout(leave, 500 * K());
    });
  }

  // ───────── обработка: очередь статусов ─────────
  function stopBatch() { clearTimeout(S.timer); S.timer = null; S.batch = null; }
  function startBatch(kind, interval, onTick, onDone, delay) {
    clearTimeout(S.timer);
    const before = new Map(P().map((p) => [p.id, p.st]));
    S.batch = { kind, before, startStraight: P().filter((p) => p.fin.st === 'straightened' && p.st === 'straightened').length };
    const queue = P().filter((p) => p.st === 'pending');
    const step = () => {
      const p = queue.shift();
      if (!p) { const b = S.batch; S.batch = null; onDone && onDone(b); return; }
      if (p.st === 'pending') { p.st = p.fin.st; p.reason = p.fin.reason; }
      onTick && onTick();
      S.timer = setTimeout(step, interval * K());
    };
    S.timer = setTimeout(step, (delay ?? interval) * K());
  }
  function resetPages() {
    S.pages = makePages(); S.hist = []; S.fut = [];
    S.cur = 0; S.sel = new Set([0]); S.anchor = 0;
  }

  // ───────── editor ─────────
  function editorHTML() {
    return `<div class="app"><div class="app__screen"><main class="editor-screen"><header class="editor-screen__toolbar"><div class="editor-screen__toolbar-left"><button type="button" class="btn btn--secondary" data-act="newscan"><span aria-hidden="true">↺</span> Новое сканирование</button><button type="button" class="btn btn--secondary editor-screen__add" data-act="add" title="В моке — сразу досканирование Д1"><span class="editor-screen__add-plus" aria-hidden="true">+</span> Добавить</button></div><div class="editor-screen__toolbar-center" id="st-tb-center"></div><div class="editor-screen__toolbar-right"><div id="iv2-edits"></div></div></header><div class="editor-screen__body"><aside class="rail" aria-label="Отсканированные страницы"><div class="rail__scroll" id="st-rail"></div><footer class="rail__footer" id="st-rail-foot"></footer></aside><section class="stage"><div class="preview"><div class="preview__paper" id="st-paper"></div></div><footer class="stage__statusbar"><button type="button" class="btn btn--icon" aria-label="Предыдущая страница" data-act="prev">←</button><div class="stage__counter" id="st-counter"></div><button type="button" class="btn btn--icon" aria-label="Следующая страница" data-act="next">→</button><span class="stage__divider" aria-hidden="true"></span><button type="button" class="btn btn--icon stage__tool" aria-label="Повернуть на 90° против часовой" title="Повернуть на 90° против часовой">↺</button><button type="button" class="btn btn--icon stage__tool" aria-label="Повернуть на 90° по часовой" title="Повернуть на 90° по часовой">↻</button><button type="button" class="btn btn--icon stage__tool stage__tool--danger" aria-label="Удалить страницу" title="Удалить страницу"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" aria-hidden="true"><path d="M2.5 3.6h9"></path><path d="M5.6 3.6V2.4h2.8v1.2"></path><path d="M3.7 3.6l.55 7.4h5.5l.55-7.4"></path><path d="M5.9 5.8v3M8.1 5.8v3"></path></svg></button></footer></section><aside class="inspector" aria-label="Сведения о наборе" id="st-insp"></aside></div></main></div></div>`;
  }
  let ED = null;
  function showEditor(animate = true) {
    ED = mount(editorHTML(), 'editor', animate);
    buildRail();
    paint(false);
    ED.addEventListener('click', onEditorClick);
    if (counts().pending && !S.batch) startEditorBatch(S.scene === 'add' ? 'add' : S.scene === 'recalc' ? 'recalc' : 'late');
  }
  function buildRail() {
    const rail = $('#st-rail', ED);
    const groups = DOCS.map((name, d) => ({ name, d, items: P().map((p, i) => [p, i]).filter(([p]) => p.doc === d) }));
    rail.innerHTML = groups.map((g) => `<section class="doc-group doc-tone--${g.d + 1}">${g.d ? '<div class="doc-group__divider"><span class="doc-group__pill">НОВЫЙ ДОКУМЕНТ</span><span class="doc-group__rule" aria-hidden="true"></span><button type="button" class="doc-group__unsplit" title="Убрать границу — присоединить к предыдущему документу" aria-label="Убрать границу перед документом 2">✕</button></div>' : ''}<div class="doc-group__header"><span class="doc-badge" aria-hidden="true">${g.d + 1}</span><input class="doc-group__name" type="text" value="${g.name}" aria-label="Название документа ${g.d + 1}" /><span class="doc-group__count">${g.items.length} стр.</span></div><ul class="thumbs" role="listbox" aria-multiselectable="true" aria-label="Страницы документа ${g.d + 1}">${g.items.map(([p, i]) => thumbHTML(p, i)).join('')}</ul></section>`).join('');
    $$('.thumb', rail).forEach((li) => paintThumb(li, false));
  }
  function thumbHTML(p, i) {
    const glued = p.blank;
    const split = i > 0 && !glued ? '<button type="button" class="thumb__split" tabindex="-1" aria-hidden="true" title="Начать новый документ с этой страницы">+ Новый документ</button>' : '';
    return `<li role="option" tabindex="-1" data-i="${i}" class="thumb${glued ? ' thumb--glued' : ''}" draggable="${glued ? 'false' : 'true'}"${glued ? ' title="Оборот идёт вместе со своей страницей"' : ''}>${split}<div class="thumb__paper"><img class="thumb__img ${skewCls(p)}" data-k="${skewCls(p)}" alt="" draggable="false" src="../reference/pages/${p.img}.jpg" />${p.blank ? '<span class="thumb__blank" aria-hidden="true">ПУСТО</span>' : ''}</div><div class="thumb__foot"><span class="thumb__num">${i + 1}</span>${p.back ? '<span class="thumb__tag">об</span>' : ''}${p.added ? `<span class="thumb__tag thumb__tag--added">${p.added}</span>` : ''}</div></li>`;
  }

  function setImg(host, cls, want, animate) {
    const cur = host.querySelector(`.${cls}:not(.st-old)`);
    if (!cur || cur.dataset.k === want) return;
    if (!animate || reduced()) { cur.className = `${cls} ${want}`; cur.dataset.k = want; return; }
    const n = cur.cloneNode();
    n.className = `${cls} st-img-new ${want}`; n.dataset.k = want;
    cur.after(n); cur.classList.add('st-old');
    void n.offsetWidth; n.classList.add('st-img-in');
    setTimeout(() => { cur.remove(); n.classList.remove('st-img-new', 'st-img-in'); }, 160 * K());
  }
  function fadeOut(el, animate) {
    if (!animate || reduced()) return el.remove();
    el.classList.add('st-fade'); setTimeout(() => el.remove(), 150 * K());
  }
  function fadeIn(parent, el, animate) {
    if (animate && !reduced()) { el.classList.add('st-fade'); parent.appendChild(el); void el.offsetWidth; requestAnimationFrame(() => el.classList.remove('st-fade')); }
    else parent.appendChild(el);
  }

  function paintThumb(li, animate) {
    const i = +li.dataset.i, p = P()[i], st = vst(p);
    const multi = S.sel.size > 1, inSel = S.sel.has(i);
    li.classList.toggle('thumb--selected', i === S.cur);
    li.classList.toggle('thumb--in-selection', multi && inSel);
    li.setAttribute('aria-selected', inSel);
    li.tabIndex = i === S.cur ? 0 : -1;
    setImg($('.thumb__paper', li), 'thumb__img', skewCls(p), animate);
    const pend = $('.thumb__pending:not(.st-fade)', li);
    if (st === 'pending' && !pend) {
      const el = document.createElement('span');
      el.className = 'thumb__pending'; el.setAttribute('aria-hidden', 'true'); el.title = 'Выравнивается — сохранение подождёт';
      el.style.setProperty('--st-phase', phase()); el.innerHTML = dots();
      fadeIn(li, el, false);
    } else if (st !== 'pending' && pend) fadeOut(pend, animate);
    const want = st === 'straightened' ? 'done' : st === 'unmeasurable' || st === 'deferred' ? 'undone' : st === 'kept' && S.keptMark ? 'kept' : null;
    const g = $('.thumb__straight:not(.st-fade)', li);
    const have = g ? g.dataset.kind : null;
    if (have !== want) {
      if (g) fadeOut(g, animate);
      if (want) {
        const el = document.createElement('span');
        el.className = 'thumb__straight thumb__straight--' + want; el.dataset.kind = want;
        el.innerHTML = glyph(want === 'done' ? 'level' : 'undone');
        el.title = titleFor(p);
        fadeIn(li, el, animate);
      }
    } else if (g) g.title = titleFor(p);
    let label = `Страница ${i + 1}` + (p.blank ? ', пустая' : '');
    if (st === 'straightened') label += ', выровнена';
    else if (st === 'unmeasurable' || st === 'deferred') label += ', не выровнена: ' + REASON[p.reason];
    else if (st === 'pending') label += ', выравнивается';
    else if (st === 'kept' && S.keptMark) label += ', оригинал по вашему выбору';
    li.setAttribute('aria-label', label);
  }

  function docPages(d) { return P().map((p, i) => [p, i]).filter(([p]) => p.doc === d); }
  function paint(animate) {
    if (S.screen !== 'editor' || !ED) return;
    $$('#st-rail .thumb', ED).forEach((li) => paintThumb(li, animate));
    const p = curP(), dp = docPages(p.doc), pos = dp.findIndex(([, i]) => i === S.cur) + 1;
    $('#st-tb-center', ED).className = `editor-screen__toolbar-center doc-tone--${p.doc + 1}`;
    $('#st-tb-center', ED).innerHTML = `<span class="editor-screen__doc-mark" aria-hidden="true"></span><span class="editor-screen__doc-title">${DOCS[p.doc]}</span>`;
    $('#st-counter', ED).textContent = `${S.cur + 1} из ${P().length}`;
    $('[data-act="prev"]', ED).setAttribute('aria-disabled', S.cur === 0);
    $('[data-act="next"]', ED).setAttribute('aria-disabled', S.cur === P().length - 1);
    paintPreview(animate);
    paintFoot();
    paintInspector();
    if (S.modal === 'save') paintSave();
  }

  function paintPreview(animate) {
    const p = curP(), paper = $('#st-paper', ED), st = vst(p);
    const docStart = S.cur === docPages(p.doc)[0][1] && p.doc > 0;
    paper.className = `preview__paper doc-tone--${p.doc + 1}${docStart ? ' preview__paper--doc-start' : ''}`;
    if (paper.dataset.id !== p.id) {
      paper.innerHTML = `<img class="preview__img ${skewCls(p)}" data-k="${skewCls(p)}" alt="Страница ${S.cur + 1}" src="../reference/pages/${p.img}.jpg" />`;
      paper.dataset.id = p.id;
    } else setImg(paper, 'preview__img', skewCls(p), animate);
    $$('.preview__straight, .preview__blank, .preview__doc-start', paper).forEach((e) => e.remove());
    if (p.blank) paper.insertAdjacentHTML('beforeend', '<span class="preview__blank">ПУСТАЯ СТОРОНА</span>');
    if (docStart) paper.insertAdjacentHTML('beforeend', `<span class="preview__doc-start">НАЧАЛО ДОКУМЕНТА ${p.doc + 1}</span>`);
    let pill = null;
    if (st === 'straightened') pill = glyph('level') + 'ВЫРОВНЕНО';
    else if (st === 'unmeasurable' || st === 'deferred') pill = glyph('undone') + 'НЕ ВЫРОВНЕНО';
    else if (st === 'pending') pill = `<span class="preview__straight-dots" style="--st-phase:${phase()}">${dots()}</span>ВЫРАВНИВАЕТСЯ`;
    else if (st === 'kept' && S.keptMark) pill = 'ОРИГИНАЛ';
    if (pill) paper.insertAdjacentHTML('beforeend', `<span class="preview__straight" title="${esc(st === 'pending' ? 'Выравнивается — сохранение подождёт' : titleFor(p))}">${pill}</span>`);
  }

  function paintFoot() {
    const foot = $('#st-rail-foot', ED);
    const sel = S.sel.size > 1 ? `<div class="rail__selection"><p class="rail__selection-text">Выделено ${S.sel.size} стр.</p><div class="rail__selection-actions"><button type="button" class="rail__selection-group">Выделить в документ</button></div></div>` : '';
    foot.innerHTML = `${sel}<div class="rail__toggles"><label class="toggle-row" title="Действует на обороты основного документа. Если обороты вверх ногами — листы сканировали без разворота."><span class="toggle"><input class="toggle__input" aria-label="Обороты на 180°" type="checkbox" /><span class="toggle__track" aria-hidden="true"></span></span><span class="toggle-row__label">Обороты на 180°</span></label></div>`;
  }

  // — инспектор —
  function selPages() { return [...S.sel].sort((a, b) => a - b).map((i) => P()[i]); }
  function straightSection() {
    if (S.mode === 'off') return '';
    const head = '<div class="inspector__heading"><h2 id="st-kicker" class="kicker">ВЫРАВНИВАНИЕ</h2></div>';
    const wrap = (inner) => `<section class="inspector__section inspector__section--straight" aria-labelledby="st-kicker">${head}${inner}</section>`;
    const KEEP_T = 'Показать и сохранить как со сканера. Это правка: Ctrl+Z или «Вернуть» её снимут.';
    const BACK_T = 'Вернуть выровненный вид. Ctrl+Z отменит.';
    if (S.sel.size > 1) {
      const ps = selPages(), n = ps.length;
      const c = { s: 0, k: 0, u: 0, l: 0, w: 0 };
      ps.forEach((p) => { if (p.st === 'straightened') c.s++; else if (p.st === 'kept') c.k++; else if (p.st === 'unmeasurable' || p.st === 'deferred') c.u++; else if (p.st === 'pending') c.w++; else if (p.st === 'level') c.l++; });
      const parts = [c.s && `выровнено ${c.s}`, c.k && `оригинал по вашему выбору — ${c.k}`, c.u && `не выровнено ${c.u}`, c.w && `в обработке ${c.w}`, c.l && `ровных ${c.l}`].filter(Boolean);
      const note = `<p class="inspector__note">Из ${n} выделенных: ${parts.length ? parts.join(', ') : 'выравнивание не применялось'}.</p>`;
      const btn = (act, label, title, dis) => `<button type="button" class="btn btn--tinted" data-act="${act}" title="${esc(title)}"${dis ? ' disabled aria-disabled="true"' : ''}>${label}</button>`;
      let acts = '';
      if (c.s) acts += btn('keep', c.s === n ? `Оставить оригинал — ${n} стр.` : `Оставить оригинал — ${c.s} из ${n} выделенных`, KEEP_T);
      if (c.k) acts += btn('straighten', c.k === n ? `Выровнять — ${n} стр.` : `Выровнять — ${c.k} из ${n} выделенных`, BACK_T);
      let reason = '';
      if (!c.s && !c.k) {
        const why = c.w && !c.u && !c.l ? 'Выделенные ещё выравниваются — действие станет доступно само.' : 'Среди выделенных нет выровненных страниц — оставлять оригинал нечему.';
        acts = btn('keep', 'Оставить оригинал', why, true);
        reason = `<p class="inspector__straight-reason">${why}</p>`;
      }
      return wrap(`${note}<div class="inspector__straight-actions">${acts}</div>${reason}`);
    }
    const p = curP();
    if (!p.st || p.st === 'level') return '';
    const key = p.st === 'unmeasurable' || p.st === 'deferred' ? p.reason : p.st;
    let act = '';
    if (p.st === 'straightened') act = `<button type="button" class="btn btn--tinted inspector__blank-action" data-act="keep" title="${esc(KEEP_T)}">Оставить оригинал</button>`;
    if (p.st === 'kept') act = `<button type="button" class="btn btn--tinted inspector__blank-action" data-act="straighten" title="${esc(BACK_T)}">Выровнять</button>`;
    return wrap(`<p class="inspector__note">${NOTE[key]}</p>${act}`);
  }
  function checkItem() {
    if (S.mode === 'off') return '';
    const c = counts();
    if (c.pending) return `<li class="check check--warning"><span class="check__icon" aria-hidden="true">•</span><span class="check__text">Выравнивание: ещё ${c.pending} стр.<span class="check__hint">Сохранение подождёт — кнопка станет доступна сама.</span></span></li>`;
    let text = c.straightened ? `Выровнено ${c.straightened} стр.` : c.undone ? 'Ни одна страница не выровнена' : 'Все страницы ровные';
    if (c.kept) text += `, ${c.kept} — оставлен${c.kept === 1 ? 'а' : 'ы'} оригиналом`;
    let hint = '';
    if (c.undone) {
      const r = ['measure', 'nohelp', 'disk', 'fail'].filter((k) => c[k]).map((k) => `${SHORT[k]} — ${c[k]}`).join(', ');
      hint = `Не выровнено ${c.undone}: ${r}.`;
      if (c.disk || c.fail) hint += c.disk ? ' Освободите место на диске — при следующем запуске приложение попробует снова.' : ' При следующем запуске приложение попробует снова.';
    }
    return `<li class="check"><span class="check__icon" aria-hidden="true">✓</span><span class="check__text">${text}${hint ? `<span class="check__hint">${hint}</span>` : ''}</span></li>`;
  }
  const FOOT = '<footer class="iv2-foot"><div class="iv2-brand"><span class="iv2-beta">BETA</span></div></footer>';
  function animateInspector(insp, before, key, wasOpen) {
    const reduced = document.body.classList.contains('st-reduced') || matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;
    const k = getComputedStyle(document.body).getPropertyValue('--st-k').trim() || 1;
    const dur = 240 * +k, easing = 'cubic-bezier(.4,0,.2,1)';
    const sc = insp.scrollTop;
    const anim = (el, from, to, extra) => {
      if (Math.abs(from - to) < 1) return;
      el.style.overflow = 'hidden';
      const kf = [{ height: from + 'px' }, { height: to + 'px' }];
      if (extra) Object.assign(kf[0], extra[0]), Object.assign(kf[1], extra[1]);
      el.animate(kf, { duration: dur, easing }).finished.then(() => { el.style.overflow = ''; });
    };
    const now = {};
    const kids = [...insp.children];
    kids.forEach((el) => { now[key(el)] = el; });
    // свёртывание «Деталей»: держим тело видимым на время анимации
    const det = now.d && now.d.querySelector('.details');
    if (det && wasOpen && det.hidden) {
      det.hidden = false;
      const h = now.d.offsetHeight;
      det.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur * .6, easing, fill: 'forwards' });
      now.d.style.overflow = 'hidden';
      now.d.animate([{ height: h + 'px' }, { height: (h - det.offsetHeight - parseFloat(getComputedStyle(now.d).rowGap || 0)) + 'px' }], { duration: dur, easing }).finished.then(() => { det.hidden = true; now.d.style.overflow = ''; });
    } else if (now.d) {
      const h = now.d.offsetHeight;
      anim(now.d, before.d ?? h, h);
      if (det && !det.hidden && !wasOpen) det.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dur, easing, delay: dur * .25, fill: 'backwards' });
    }
    const arrow = now.d && now.d.querySelector('.details-toggle__arrow');
    if (arrow && wasOpen !== !!S.details) arrow.animate([{ transform: 'rotate(' + (wasOpen ? 180 : 0) + 'deg)' }, { transform: 'rotate(' + (S.details ? 180 : 0) + 'deg)' }], { duration: dur, easing });
    // появление / смена / исчезновение «Выравнивания»
    if (now.s) {
      const h = now.s.offsetHeight;
      if (before.s == null) anim(now.s, 0, h, [{ opacity: 0 }, { opacity: 1 }]);
      else anim(now.s, before.s, h);
    } else if (before.s != null && now.docs) {
      const ghost = document.createElement('div');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.style.cssText = 'flex:none;height:' + before.s + 'px';
      insp.insertBefore(ghost, now.docs);
      ghost.animate([{ height: before.s + 'px' }, { height: '0px' }], { duration: dur, easing }).finished.then(() => ghost.remove());
    }
    insp.scrollTop = sc;
  }
  function paintInspector() {
    const p = curP(), st = vst(p);
    const facts = [['Лист', '№' + p.sheet], ['Сторона', p.back ? 'оборот' : 'лицо']];
    if (p.blank) facts.push(['Содержимое', 'пустая — с меткой']);
    if (st) facts.push(['Выравнивание', FACT[st === 'unmeasurable' || st === 'deferred' ? p.reason : st]]);
    facts.push(['Поворот', '0°']);
    const checks = `<div class="iv2-checks"><h3 class="kicker iv2-sub">ПРОВЕРКА</h3><ul class="checks"><li class="check"><span class="check__icon" aria-hidden="true">✓</span><span class="check__text">Лица и обороты собраны: 12 листов</span></li><li class="check"><span class="check__icon" aria-hidden="true">✓</span><span class="check__text">Помечено 2 пустых оборота — останутся в файле</span></li>${checkItem()}<li class="check"><span class="check__icon" aria-hidden="true">✓</span><span class="check__text">Порядок соответствует сканированию</span></li></ul></div>`;
    const details = `<section class="inspector__section inspector__section--details"><button type="button" class="details-toggle" aria-expanded="${S.details}" data-act="details"><span class="kicker">ДЕТАЛИ</span><span class="details-toggle__rule" aria-hidden="true"></span><span class="details-toggle__summary">стр. ${S.cur + 1}</span><span class="details-toggle__arrow" aria-hidden="true">▾</span></button><div class="details"${S.details ? '' : ' hidden'}><h2 class="details__title">Стр. ${S.cur + 1} — ${p.back ? 'оборот' : 'лицо'} листа ${p.sheet}</h2><dl class="facts">${facts.map(([k, v]) => `<div class="facts__row"><dt class="facts__key">${k}</dt><dd class="facts__value">${v}</dd></div>`).join('')}</dl>${checks}</div></section>`;
    const docs = `<section class="inspector__section"><div class="inspector__heading"><h2 class="kicker">ДОКУМЕНТЫ В НАБОРЕ</h2><span class="inspector__meta">2 документа</span></div><ul class="doc-list">${DOCS.map((name, d) => { const dp = docPages(d); return `<li><button type="button" class="doc-list__item doc-tone--${d + 1}"${p.doc === d ? ' aria-current="true"' : ''} data-act="doc" data-d="${d}"><span class="doc-badge doc-badge--small" aria-hidden="true">${d + 1}</span><span class="doc-list__text"><span class="doc-list__name">${name}</span><span class="doc-list__meta">${dp.length} стр. · стр. ${dp[0][1] + 1}–${dp[dp.length - 1][1] + 1} набора</span></span></button></li>`; }).join('')}</ul><p class="inspector__note">При сохранении получится 2 отдельных файла — по отмеченным границам.</p><button type="button" class="btn btn--primary iv2-save" data-act="save">Сохранить 2 файла</button></section>`;
    const edited = P().some((p) => p.st === 'kept');
    const bar = edited ? '<div class="edits-bar" role="status"><span class="dot dot--warning iv2-blink" aria-hidden="true"></span><p class="edits-bar__text">Есть ручные правки</p><button type="button" class="btn btn--tinted" data-act="revert" title="Вернуть всё как после сканирования">Вернуть</button></div>' : '';
    const insp = $('#st-insp', ED);
    const scroll = insp.scrollTop;
    const key = (el) => el.classList.contains('inspector__section--details') ? 'd' : el.classList.contains('inspector__section--straight') ? 's' : el.tagName === 'FOOTER' ? 'f' : 'docs';
    const before = {}; [...insp.children].forEach((el) => { before[key(el)] = el.offsetHeight; });
    const wasOpen = !!insp.querySelector('.details:not([hidden])');
    const hadAny = insp.children.length > 0;
    insp.innerHTML = details + straightSection() + docs + FOOT;
    if (hadAny) animateInspector(insp, before, key, wasOpen);
    $('#iv2-edits', ED).innerHTML = bar;
    insp.scrollTop = scroll;
  }

  // — правки —
  function edit(to, idx) {
    const from = to === 'kept' ? 'straightened' : 'kept';
    const ps = idx.map((i) => P()[i]).filter((p) => p.st === from);
    if (!ps.length) return;
    const e = { ps, from, to };
    e.ps.forEach((p) => (p.st = to));
    S.hist.push(e); S.fut = [];
    paint(true);
    // Тост — только на выделение: страницы меняются в ленте, часть может быть вне видимости.
    if (ps.length > 1) toast(to === 'kept' ? `Оставлены оригиналы: ${ps.length} стр. — Ctrl+Z отменит` : `Выровнено ${ps.length} стр. — Ctrl+Z отменит`);
  }
  function undo() { const e = S.hist.pop(); if (!e) return; e.ps.forEach((p) => (p.st = e.from)); S.fut.push(e); paint(true); }
  function redo() { const e = S.fut.pop(); if (!e) return; e.ps.forEach((p) => (p.st = e.to)); S.hist.push(e); paint(true); }

  function select(i, ev) {
    if (ev && ev.shiftKey) { const [a, b] = [Math.min(S.anchor, i), Math.max(S.anchor, i)]; S.sel = new Set(); for (let k = a; k <= b; k++) S.sel.add(k); }
    else if (ev && (ev.ctrlKey || ev.metaKey)) { if (S.sel.has(i) && S.sel.size > 1) S.sel.delete(i); else S.sel.add(i); S.anchor = i; }
    else { S.sel = new Set([i]); S.anchor = i; }
    S.cur = i;
    paint(false);
  }
  function go(i) { if (i < 0 || i >= P().length) return; S.cur = i; S.sel = new Set([i]); S.anchor = i; paint(false); $(`#st-rail .thumb[data-i="${i}"]`, ED)?.focus({ preventScroll: true }); scrollThumb(i); }
  function scrollThumb(i) { const li = $(`#st-rail .thumb[data-i="${i}"]`, ED), box = $('#st-rail', ED); if (!li) return; const t = li.offsetTop - box.offsetTop; if (t < box.scrollTop || t + li.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = t - 40; }

  function onEditorClick(e) {
    const th = e.target.closest('.thumb');
    if (th && !e.target.closest('.thumb__split')) return select(+th.dataset.i, e);
    const a = e.target.closest('[data-act]');
    if (!a || a.disabled) return;
    const act = a.dataset.act;
    if (act === 'details') { S.details = !S.details; paintInspector(); }
    if (act === 'keep') edit('kept', [...(S.sel.size > 1 ? S.sel : [S.cur])]);
    if (act === 'straighten') edit('straightened', [...(S.sel.size > 1 ? S.sel : [S.cur])]);
    if (act === 'prev') go(S.cur - 1);
    if (act === 'next') go(S.cur + 1);
    if (act === 'doc') go(docPages(+a.dataset.d)[0][1]);
    if (act === 'save') openSave();
    if (act === 'revert') openRevert();
    if (act === 'add') scenario('add');
    if (act === 'newscan') showSetup();
  }

  // — тост —
  function toast(text, action, ms = 2600) {
    const app = $('.st-screen:last-child .app', stack);
    $$('.st-toast', stack).forEach((t) => t.remove());
    clearTimeout(S.toastTimer);
    const t = document.createElement('div');
    t.className = 'toast st-toast'; t.setAttribute('role', 'status');
    t.innerHTML = action ? `<span class="toast__text">${text}</span><button type="button" class="toast__action">${action}</button>` : text;
    app.appendChild(t);
    void t.offsetWidth; t.classList.add('st-toast--in');
    S.toastTimer = setTimeout(() => { t.classList.add('st-toast--out'); setTimeout(() => t.remove(), 120 * K()); }, ms * K());
    t.addEventListener('click', (e) => { if (e.target.closest('.toast__action')) t.remove(); });
  }

  // — модалки —
  function closeModal() { $$('.st-modal', stack).forEach((m) => m.remove()); S.modal = null; }
  function openRevert() {
    S.modal = 'revert';
    $('.editor-screen', ED).insertAdjacentHTML('beforeend', `<div class="modal-overlay st-modal"><section role="dialog" aria-modal="true" aria-labelledby="rv-title" class="modal modal--small"><header class="modal__header"><h2 id="rv-title" class="modal__title">Вернуть всё как после сканирования?</h2><p class="modal__subtitle">Порядок, повороты, удаления, границы, имена и выбор «Оставить оригинал» вернутся к исходным. Ctrl+Z отменит возврат.</p></header><footer class="modal__footer modal__footer--end"><button type="button" class="btn btn--ghost" data-m="cancel">Отмена</button><button type="button" class="btn btn--primary btn--small" data-m="ok">Вернуть</button></footer></section></div>`);
    const m = $('.st-modal', ED);
    $('[data-m="cancel"]', m).focus();
    m.addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]'); if (!b) return;
      closeModal();
      if (b.dataset.m === 'ok') {
        const ps = P().filter((p) => p.st === 'kept');
        if (ps.length) { ps.forEach((p) => (p.st = 'straightened')); S.hist.push({ ps, from: 'kept', to: 'straightened' }); S.fut = []; }
        paint(true); toast('Всё возвращено как после сканирования');
      }
    });
  }
  function openSave() {
    S.modal = 'save';
    $('.editor-screen', ED).insertAdjacentHTML('beforeend', `<div class="modal-overlay st-modal"><section role="dialog" aria-modal="true" aria-labelledby="save-title" tabindex="-1" class="modal save-modal"><header class="modal__header"><h2 id="save-title" class="modal__title">Сохранить 2 файла</h2></header><div class="modal__body"><div class="modal__section"><h3 class="kicker">ЧТО СОХРАНЯЕМ</h3><div class="save-modal__modes" role="radiogroup"><button type="button" class="save-mode" role="radio" aria-checked="true"><span>Отдельные файлы</span><span class="save-mode__hint">по границам: 2 файла</span></button><button type="button" class="save-mode" role="radio" aria-checked="false"><span>Один файл</span><span class="save-mode__hint">все ${P().length} стр. подряд</span></button></div></div><div class="modal__section"><h3 class="kicker">ФАЙЛЫ · 2</h3><ul class="save-files">${DOCS.map((n, d) => `<li class="save-file doc-tone--${d + 1}"><span class="doc-badge doc-badge--small" aria-hidden="true">${d + 1}</span><input class="save-file__name" type="text" value="${n}" aria-label="Имя файла ${d + 1}" /><span class="save-file__ext">.pdf</span><span class="save-file__meta">${docPages(d).length} стр.</span></li>`).join('')}</ul></div><div class="modal__section"><h3 class="kicker">ПАПКА</h3><div class="save-folder"><span class="save-folder__icon" aria-hidden="true"></span><p class="save-folder__path">C:\\Users\\Анна\\Documents\\Сканы</p><button type="button" class="btn btn--tinted">Выбрать…</button></div></div><dl class="facts" id="st-save-facts"></dl></div><footer class="modal__footer"><p class="modal__status" id="st-save-status" role="status" aria-live="polite"></p><button type="button" class="btn btn--ghost" data-m="cancel">Отмена</button><button type="button" class="btn btn--primary btn--small" data-m="save">Сохранить 2 файла</button></footer></section></div>`);
    const m = $('.st-modal', ED);
    m.addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]'); if (!b || b.disabled) return;
      closeModal();
      if (b.dataset.m === 'save') toast('Сохранено 2 файла → Сканы', 'Открыть папку', 6000);
    });
    paintSave();
  }
  function paintSave() {
    const m = $('.st-modal', ED); if (!m) return;
    const c = counts();
    const rows = [['Файлов', '2'], ['Страниц всего', String(P().length)], ['Пустых оборотов', 'помечено 2 — останутся в файле']];
    if (S.mode === 'on') {
      let v = c.straightened ? `${c.straightened} стр.` : 'нет';
      if (c.pending) v += ` · ещё ${c.pending} в обработке`;
      else if (c.undone) v += ` · не выровнено ${c.undone} — уйдут как есть`;
      rows.push(['Выровнено', v]);
    }
    rows.push(['Формат', 'PDF']);
    $('#st-save-facts', m).innerHTML = rows.map(([k, v]) => `<div class="facts__row"><dt class="facts__key">${k}</dt><dd class="facts__value">${v}</dd></div>`).join('');
    const btn = $('[data-m="save"]', m);
    const wait = S.mode === 'on' && c.pending > 0;
    btn.disabled = wait; btn.setAttribute('aria-disabled', wait);
    $('#st-save-status', m).textContent = wait ? `Выравнивание: ещё ${c.pending} стр. из ${S.batchTotal} — кнопка станет доступна сама.` : '';
  }

  // ───────── сценарии ─────────
  function startEditorBatch(kind) {
    S.batchTotal = Math.max(S.batchTotal, counts().pending);
    startBatch(kind, 800, () => paint(true), (b) => {
      paint(true);
      if (S.screen !== 'editor' || S.mode === 'off') return;
      const nowS = P().filter((p) => p.st === 'straightened' && b.before.get(p.id) === 'pending').length;
      if (kind === 'recalc') toast(nowS ? `Выравнивание пересчитано — выровнено ещё ${nowS} стр.` : 'Выравнивание пересчитано');
      else if (nowS) toast(`Выровнено ещё ${nowS} стр.`);
    }, 600);
  }
  function setMode(m) {
    S.mode = m;
    $$('#st-mode .segment').forEach((b) => b.classList.toggle('segment--selected', b.dataset.mode === m));
  }
  function scenario(sc) {
    S.scene = sc;
    $$('#st-sc .segment').forEach((b) => b.classList.toggle('segment--selected', b.dataset.sc === sc));
    closeModal();
    if (sc === 'add') {
      // Досканирование: страницы дописываются, статусы приходят уже в editor. Стек undo очищается (UI_SPEC 6.8).
      stopBatch();
      if (S.screen !== 'editor') { resetPages(); showEditor(); }
      const base = P().length;
      if (P().some((p) => p.added)) { S.pages = P().filter((p) => !p.added); }
      const n0 = P().length;
      const fin = [['straightened'], ['level'], ['straightened'], ['unmeasurable', 'measure']];
      fin.forEach((f, k) => P().push({ id: 'a' + k, sheet: k < 2 ? 1 : 2, back: k % 2 === 1, blank: false, doc: 1, added: 'Д1', img: 'page-0' + (k + 1), skew: k % 2 ? 'r' : 'l', origSkew: f[0] !== 'level', st: S.mode === 'on' ? 'pending' : null, reason: null, fin: { st: f[0], reason: f[1] || null } }));
      S.hist = []; S.fut = [];
      buildRail(); go(n0); toast('Добавлено 4 стр.');
      S.batchTotal = 4;
      if (S.mode === 'on') startEditorBatch('add');
      return;
    }
    stopBatch(); resetPages();
    if (sc === 'partial') { P().forEach((p, i) => { if (p.fin.st && i >= 9) p.st = 'pending'; }); S.batchTotal = counts().pending; }
    if (sc === 'recalc') {
      // После обновления приложения коррекция пересчитывается: часть страниц меняет статус на месте.
      [7, 9, 15].forEach((i) => { const p = P()[i]; p.st = 'pending'; p.fin = { st: 'straightened', reason: null }; });
      S.batchTotal = 3;
    }
    if (sc === 'save') { P().forEach((p, i) => { if (p.fin.st && i >= 16) p.st = 'pending'; }); S.batchTotal = counts().pending; }
    if (S.mode === 'off') P().forEach((p) => { if (p.st === 'pending') { p.st = p.fin.st; p.reason = p.fin.reason; } });
    showEditor(S.screen !== 'editor');
    if (sc === 'save') openSave();
  }

  // — клавиатура —
  document.addEventListener('keydown', (e) => {
    if (S.screen !== 'editor' || !ED) return;
    if (S.modal) { if (e.key === 'Escape') closeModal(); return; }
    if (e.target.closest && e.target.closest('input, textarea')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (mod && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(S.cur + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(S.cur - 1); }
    else if (e.key === 'Escape') { S.sel = new Set([S.cur]); paint(false); }
  });

  // — панель —
  $('#st-panel-toggle').addEventListener('click', () => {
    const p = $('#st-panel'), c = p.dataset.collapsed === 'true';
    p.dataset.collapsed = c ? 'false' : 'true';
    $('#st-panel-toggle').setAttribute('aria-expanded', c);
  });
  $('#st-jump').addEventListener('click', (e) => {
    const b = e.target.closest('[data-jump]'); if (!b) return;
    if (b.dataset.jump === 'setup') showSetup();
    if (b.dataset.jump === 'merge') runMerge();
    if (b.dataset.jump === 'editor') scenario(S.scene === 'add' ? 'done' : S.scene);
  });
  $('#st-sc').addEventListener('click', (e) => { const b = e.target.closest('[data-sc]'); if (b) scenario(b.dataset.sc); });
  $('#st-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]'); if (!b) return;
    setMode(b.dataset.mode);
    if (S.screen === 'editor') scenario(S.scene === 'add' ? 'done' : S.scene);
  });
  $('#st-kept').addEventListener('change', (e) => { S.keptMark = e.target.checked; paint(true); });
  $('#st-offline').addEventListener('change', (e) => { S.setup.online = !e.target.checked; if (S.screen === 'setup') rerenderSetup(); else showSetup(); });
  $('#st-reduce').addEventListener('change', (e) => document.body.classList.toggle('st-reduced', e.target.checked));
  $('#st-slow').addEventListener('change', (e) => document.body.classList.toggle('st-slow', e.target.checked));

  // — вписать окно в ширину —
  function fit() {
    const w = Math.min(1, (document.documentElement.clientWidth - 48) / 1280);
    $('#st-frame').style.transform = w < 1 ? `scale(${w})` : '';
    $('#st-fit').style.height = 800 * w + 'px';
  }
  addEventListener('resize', fit); fit();

  scenario('done');
})();
