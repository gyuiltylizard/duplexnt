// M6: варианты пометок выравнивания — демо-обвязка страницы вариантов.
(() => {
  const REASON = {
    measure: 'не по чему мерить',
    nohelp: 'коррекция не помогла',
    disk: 'мало места на диске',
    fail: 'сбой коррекции',
  };
  const HINT = {
    measure: 'Не выровнено: не по чему мерить — страница оставлена как есть',
    nohelp: 'Не выровнено: коррекция не помогла — страница оставлена как есть',
    disk: 'Не выровнено: мало места на диске — освободите место, при следующем запуске приложение попробует снова',
    fail: 'Не выровнено: сбой коррекции — при следующем запуске приложение попробует снова',
  };
  const PAGES = [
    { n: 1, img: 'page-01', fin: 'straightened', skew: 'l', sel: true },
    { n: 2, img: 'page-02', tag: true, fin: 'straightened', skew: 'r' },
    { n: 3, img: 'page-03', fin: 'level' },
    { n: 4, img: 'page-04', tag: true, fin: 'unmeasurable', reason: 'measure', skew: 'l' },
    { n: 5, img: 'page-05', fin: 'straightened', skew: 'r' },
    { n: 6, img: 'blank', tag: true, fin: null, blank: true },
    { n: 7, img: 'page-07', added: true, fin: 'deferred', reason: 'disk', skew: 'r' },
    { n: 8, img: 'page-08', tag: true, added: true, fin: 'unmeasurable', reason: 'nohelp', skew: 'l' },
    { n: 9, img: 'page-09', fin: 'straightened', skew: 'l' },
    { n: 10, img: 'page-10', tag: true, fin: 'deferred', reason: 'fail', skew: 'r' },
    { n: 11, img: 'page-11', fin: 'kept', skew: 'l' },
    { n: 12, img: 'blank', tag: true, fin: null, blank: true, hidden: true },
  ];
  // Глифы 10×9: ровные строки и варианты «не выровнено».
  const GLYPH = {
    level: 'M0.6 1H9.4M0.6 4.5H9.4M0.6 8H9.4',
    fan: 'M0.6 3L9.4 0.6M0.6 4.5H9.4M0.6 6L9.4 8.4',
    tilt: 'M0.6 3.1L9.4 1M0.6 6.1L9.4 4M0.6 9.1L9.4 7',
    'tilt-text': 'M0.6 3.1L9.4 1M0.6 6.1L9.4 4M0.6 9.1L5.6 7.9',
    wave: 'M0.6 1.2Q2.8 -0.2 5 1.2T9.4 1.2M0.6 4.6Q2.8 3.2 5 4.6T9.4 4.6M0.6 8Q2.8 6.6 5 8T9.4 8',
    'tilt-wave': 'M0.6 2.8Q2.8 1 5 1.9T9.4 0.7M0.6 6Q2.8 4.2 5 5.1T9.4 3.9M0.6 9.2Q2.8 7.4 5 8.3T9.4 7.1',
  };
  const svg = (g) => `<svg class="sv-glyph" viewBox="0 0 10 9" aria-hidden="true"><path d="${GLYPH[g]}" /></svg>`;
  document.querySelectorAll('.sv-spec').forEach((s) => {
    const pair = (cls) => `<div class="sv-spec__pair ${cls}">${svg('level')}${svg(s.dataset.gl)}</div>`;
    s.innerHTML = pair('') + '<span class="sv-spec__sep"></span>' + pair('sv-spec__pair--big');
  });

  // Состояние общее для всех лент: статус на страницу. Стартовое — 9 и 10 ещё в обработке.
  const status = {};
  PAGES.forEach((p) => (status[p.n] = p.n === 9 || p.n === 10 ? 'pending' : p.fin));

  const settings = { wait1: 'a', mark2: 'a' };
  const rails = [...document.querySelectorAll('.sv-rail')];
  const k = () => (document.body.classList.contains('sv-slow') ? 4 : 1);

  function railMark(r) { return r.dataset.mark || settings.mark2; }
  function railWait(r) { return r.dataset.wait || settings.wait1; }

  function buildRail(rail) {
    rail.dataset.mk = railMark(rail);
    rail.dataset.wt = railWait(rail);
    rail.innerHTML = `<section class="doc-group doc-tone--1"><div class="doc-group__header"><span class="doc-badge" aria-hidden="true">1</span><input class="doc-group__name" type="text" value="Договор аренды" aria-label="Название документа 1" /><span class="doc-group__count">12 стр.</span></div><ul class="thumbs" role="listbox" aria-multiselectable="true" aria-label="Страницы документа 1"></ul></section>`;
    const ul = rail.querySelector('.thumbs');
    PAGES.forEach((p) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.dataset.n = p.n;
      li.className = 'thumb' + (p.sel ? ' thumb--selected' : '') + (p.hidden ? ' thumb--hidden' : '');
      li.innerHTML = `<div class="thumb__paper"><img class="thumb__img" alt="" draggable="false" src="../reference/pages/${p.img}.jpg" />${p.blank ? '<span class="thumb__blank" aria-hidden="true">ПУСТО</span>' : ''}</div><div class="thumb__foot"><span class="thumb__num">${p.n}</span>${p.tag ? '<span class="thumb__tag">об</span>' : ''}${p.added ? '<span class="thumb__tag thumb__tag--added">Д1</span>' : ''}</div>`;
      li.addEventListener('click', () => toggleKeep(p.n));
      ul.appendChild(li);
      paint(rail, li, p, false);
    });
  }

  function markEl(rail, st, p) {
    const done = st === 'straightened';
    const el = document.createElement('span');
    el.className = 'thumb__skew ' + (done ? 'thumb__skew--done' : 'thumb__skew--undone');
    el.title = done ? 'Выровнено — исходный скан цел' : HINT[p.reason];
    el.setAttribute('aria-hidden', 'true');
    const mk = railMark(rail);
    if (mk === 'a') el.textContent = done ? 'ВЫРОВНЕНО' : 'НЕ ВЫРОВНЕНО';
    if (mk === 'b') el.innerHTML = svg(done ? 'level' : rail.dataset.gl || 'fan');
    return el;
  }

  function fadeOut(el) {
    if (!el) return;
    if (document.body.classList.contains('mv-reduced')) return el.remove();
    el.classList.add('sv-enter');
    setTimeout(() => el.remove(), 150 * k());
  }
  function fadeIn(parent, el, animate) {
    if (animate && !document.body.classList.contains('mv-reduced')) {
      el.classList.add('sv-enter');
      parent.appendChild(el);
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('sv-enter')));
    } else parent.appendChild(el);
  }

  function paint(rail, li, p, animate) {
    const st = status[p.n];
    // Вид картинки: оригинал косой, кроме ровных и выправленных.
    const skewed = p.skew && st !== 'straightened' && st !== 'level';
    li.classList.toggle('sv-skew-l', skewed && p.skew === 'l');
    li.classList.toggle('sv-skew-r', skewed && p.skew === 'r');
    li.classList.toggle('thumb--pending', st === 'pending');
    // Индикатор обработки
    const pend = li.querySelector('.thumb__pending:not(.sv-enter)');
    if (st === 'pending' && !pend) {
      const el = document.createElement('span');
      el.className = 'thumb__pending';
      el.setAttribute('aria-hidden', 'true');
      el.title = 'Выравнивается — сохранение подождёт';
      if (railWait(rail) === 'a') el.innerHTML = '<i></i><i></i><i></i>';
      const host = railWait(rail) === 'a' ? li : li.querySelector('.thumb__paper');
      if (railWait(rail) !== 'c') host.appendChild(el);
    } else if (st !== 'pending' && pend) fadeOut(pend);
    // Пометка
    const want = st === 'straightened' ? 'done' : st === 'unmeasurable' || st === 'deferred' ? 'undone' : null;
    const cur = li.querySelector('.thumb__skew:not(.sv-enter)');
    const curKind = cur ? (cur.classList.contains('thumb__skew--done') ? 'done' : 'undone') : null;
    if (curKind !== want) {
      fadeOut(cur);
      if (want) {
        const host = railMark(rail) === 'b' ? li.querySelector('.thumb__foot') : li.querySelector('.thumb__paper');
        fadeIn(host, markEl(rail, st, p), animate);
      }
    }
    // Подпись для скринридера
    let label = `Страница ${p.n}` + (p.blank ? ', пустая' : '');
    if (st === 'straightened') label += ', выровнена';
    else if (st === 'unmeasurable' || st === 'deferred') label += ', не выровнена: ' + REASON[p.reason];
    else if (st === 'pending') label += ', выравнивается';
    li.setAttribute('aria-label', label);
  }

  function paintAll(animate) {
    rails.forEach((r) => r.querySelectorAll('.thumb').forEach((li) => paint(r, li, PAGES[li.dataset.n - 1], animate)));
    const n = Object.values(status).filter((s) => s === 'pending').length;
    document.getElementById('sv-state').textContent = n ? `в обработке: ${n} стр.` : 'всё обработано';
  }

  function toggleKeep(n) {
    if (status[n] === 'straightened') status[n] = 'kept';
    else if (status[n] === 'kept') status[n] = 'straightened';
    else return;
    paintAll(true);
  }

  let timer = null;
  function run() {
    clearTimeout(timer);
    PAGES.forEach((p) => { if (p.fin && p.fin !== 'kept') status[p.n] = 'pending'; });
    // Пересобрать ленты, чтобы все индикаторы стартовали в одной фазе.
    rails.forEach(buildRail);
    paintAll(false);
    const queue = PAGES.filter((p) => status[p.n] === 'pending');
    const step = () => {
      const p = queue.shift();
      if (!p) return;
      status[p.n] = p.fin;
      paintAll(true);
      timer = setTimeout(step, 800 * k());
    };
    timer = setTimeout(step, 1200 * k());
  }

  document.getElementById('sv-run').addEventListener('click', run);
  document.getElementById('sv-reduce').addEventListener('change', (e) => document.body.classList.toggle('mv-reduced', e.target.checked));
  document.getElementById('sv-slow').addEventListener('change', (e) => document.body.classList.toggle('sv-slow', e.target.checked));
  document.querySelectorAll('.sv-seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('.segment');
      if (!b) return;
      seg.querySelectorAll('.segment').forEach((x) => {
        const on = x === b;
        x.classList.toggle('segment--selected', on);
        x.setAttribute('aria-checked', on);
      });
      settings[seg.dataset.target] = b.dataset.value;
      rails.filter((r) => r.dataset.group === (seg.dataset.target === 'wait1' ? '1' : '2')).forEach(buildRail);
      paintAll(false);
    });
  });

  rails.forEach(buildRail);
  paintAll(false);
})();
