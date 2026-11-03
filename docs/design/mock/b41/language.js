// B-41 мок: setup на двух языках с переключателем в углу «Как это работает» (вариант 1c).
(() => {
  const T = {
    ru: {
      kicker: 'НОВОЕ СКАНИРОВАНИЕ', title: 'Сканируем обе стороны в два прохода',
      lead: 'Сначала лицевые стороны всех листов. Потом вы развернёте их на 180° — все разом, не переворачивая — и приложение само сопоставит обороты с лицами.',
      ready: 'готов', change: 'Сменить', none: 'Сканер не подключён', add: 'Добавить сканер',
      color: 'Цвет', colorV: 'Оттенки серого', res: 'Разрешение', resT: 'обычный текст', size: 'Размер листа', sizeT: '210×297 мм',
      blanks: 'Пустые обороты', blanksO: [['hide', 'Скрывать', 'не попадут в файл'], ['mark', 'Помечать', 'останутся, но с меткой'], ['keep', 'Оставлять', 'сохранить всё как есть']],
      straight: 'Выравнивание', straightO: [['auto', 'Выравнивать', 'страницы, отсканированные с искажением, будут выпрямлены. Режим будет сохранён: новый выбор будет действовать со следующего сканирования'], ['off', 'Не трогать', 'страницы останутся как со сканера. Режим будет сохранён: новый выбор будет действовать со следующего сканирования']],
      reset: 'Сбросить параметры', launch: 'Сканировать лицевые стороны', hint: 'Положите листы в лоток лицом вверх, первая страница сверху',
      how: 'КАК ЭТО РАБОТАЕТ',
      steps: [['Лицевые стороны', 'Листы лицом вверх, первая страница сверху'], ['Разворот на 180°', 'Все листы разом, не переворачивая'], ['Обратная сторона', 'Приложение знает, что обороты идут в обратном порядке'], ['Проверка и сохранение', 'Порядок соберётся сам — проверьте его и сохраните документ']],
      lang: 'Язык', langKicker: 'ЯЗЫК', fail: 'Не удалось сохранить язык — попробуйте ещё раз',
    },
    en: {
      kicker: 'NEW SCAN', title: 'Scanning both sides in two passes',
      lead: 'First the front sides of all sheets. Then you turn them 180° — all at once, without flipping — and the app matches the backs to the fronts itself.',
      ready: 'ready', change: 'Change', none: 'No scanner connected', add: 'Add scanner',
      color: 'Color', colorV: 'Grayscale', res: 'Resolution', resT: 'regular text', size: 'Paper size', sizeT: '210×297 mm',
      blanks: 'Blank backs', blanksO: [['hide', 'Hide', 'left out of the file'], ['mark', 'Mark', 'kept, but marked'], ['keep', 'Keep', 'save everything as is']],
      straight: 'Straightening', straightO: [['auto', 'Straighten', 'pages scanned with distortion will be straightened. The mode is remembered: a new choice applies from the next scan'], ['off', 'Leave as is', 'pages stay as they came from the scanner. The mode is remembered: a new choice applies from the next scan']],
      reset: 'Reset settings', launch: 'Scan the front sides', hint: 'Load the sheets into the tray face up, first page on top',
      how: 'HOW IT WORKS',
      steps: [['Front sides', 'Sheets face up, first page on top'], ['Turn 180°', 'All sheets at once, without flipping'], ['Back sides', 'The app knows the backs come in reverse order'], ['Check and save', 'The order comes together on its own — check it and save the document']],
      lang: 'Language', langKicker: 'LANGUAGE', fail: 'Couldn’t save the language — try again',
    },
  };
  // Правки английской копии из handoff'а (секция «English copy review»), только экран setup.
  const EN_REVIEW = {
    kicker: 'SCAN SETUP',
    lead: 'First the front sides of all sheets. Then you turn them 180° — all at once, without flipping — and the app matches the backs to the fronts on its own.',
    reset: 'Reset scan settings',
    straightO: [['auto', 'Straighten', 'skewed pages are straightened. The mode is remembered: a new choice applies from the next scan'], ['off', 'Leave as is', 'pages stay as they came from the scanner. The mode is remembered: a new choice applies from the next scan']],
  };
  const LANGS = [['ru', 'Русский'], ['en', 'English']];
  const DEFAULTS = { blanks: 'hide', straight: 'auto' };
  const page = { system: 'ru', write: 'ok', device: 'ready', copy: 'new' };
  const frame = document.getElementById('lv-frame');
  let s;

  const strings = (lang) => (lang === 'en' && page.copy === 'new' ? { ...T.en, ...EN_REVIEW } : T[lang]);
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const seg = (name, key, opts, cur, off) =>
    `<div class="segments" role="radiogroup" aria-label="${esc(name)}" data-param="${key}"${off ? ' aria-disabled="true"' : ''}>` +
    opts.map(([v, l, t]) => `<button type="button" role="radio" aria-checked="${v === cur}" data-value="${v}" class="segment${v === cur ? ' segment--selected' : ''}"${t ? ` title="${esc(t)}"` : ''}>${l}</button>`).join('') + '</div>';
  const row = (label, body) => `<div class="param-row"><div class="param-row__label">${label}</div>${body}</div>`;

  function render() {
    const t = strings(s.lang), off = page.device === 'none';
    const device = off
      ? `<div class="device-row"><div class="device-row__none">${t.none}</div><span class="device-row__spacer"></span><button type="button" class="btn btn--ghost">${t.add}</button></div>`
      : `<div class="device-row"><div class="device-row__name">ScanPro 200</div><div class="device-row__status"><span class="dot dot--ready" aria-hidden="true"></span><span class="device-row__status-text">${t.ready}</span></div><span class="device-row__spacer"></span><button type="button" class="btn btn--ghost">${t.change}</button></div>`;
    frame.setAttribute('lang', s.lang);
    frame.innerHTML =
      `<div class="ref-root"><div class="app"><div class="app__screen"><main class="setup-screen"><section class="setup-screen__column">` +
      `<header class="setup-screen__intro"><div class="kicker">${t.kicker}</div><h1 class="setup-screen__title">${t.title}</h1><p class="setup-screen__lead">${t.lead}</p></header>` +
      `<div class="params">${device}` +
      row(t.color, seg(t.color, 'color', [['g', t.colorV]], 'g', off)) +
      row(t.res, seg(t.res, 'res', [['300', '300 dpi', t.resT]], '300', off)) +
      row(t.size, seg(t.size, 'size', [['A4', 'A4', t.sizeT]], 'A4', off)) +
      row(t.blanks, seg(t.blanks, 'blanks', t.blanksO, s.blanks, off)) +
      row(t.straight, seg(t.straight, 'straight', t.straightO, s.straight, off)) +
      `<div class="params__footer"><button type="button" class="btn btn--ghost" data-reset${off ? ' disabled' : ''}>${t.reset}</button></div></div>` +
      `<div class="setup-screen__launch"><button type="button" class="btn btn--primary btn--large"${off ? ' disabled' : ''}>${t.launch}</button><p class="setup-screen__hint">${t.hint}</p></div></section>` +
      `<aside class="setup-screen__aside" aria-label="${t.how}"><div class="kicker">${t.how}</div><ol class="howto">` +
      t.steps.map(([a, b], i) => `<li class="howto__step"><span class="howto__num" aria-hidden="true">${i + 1}</span><span class="howto__body"><span class="howto__title">${a}</span><span class="howto__text">${b}</span></span></li>`).join('') + `</ol>` +
      `<div class="lang-switch" role="radiogroup" aria-label="${t.lang}"><span class="kicker" aria-hidden="true">${t.langKicker}</span><span class="lang-switch__opts">` +
      LANGS.map(([v, l]) => `<button type="button" role="radio" lang="${v}" aria-checked="${v === s.lang}" data-lang="${v}" class="lang-switch__opt">${l}</button>`).join('') +
      `</span></div></aside></main></div></div></div>`;
    if (s.toast) frame.querySelector('.app').appendChild(s.toast);
  }

  function log(msg) {
    const ul = document.getElementById('lv-log'), li = document.createElement('li');
    li.textContent = msg; ul.prepend(li);
    while (ul.children.length > 8) ul.lastChild.remove();
  }

  function toast(text) {
    clearTimeout(s.toastTimer);
    if (s.toast) s.toast.remove();
    const el = document.createElement('div');
    el.className = 'toast'; el.setAttribute('role', 'status'); el.textContent = text;
    s.toast = el; frame.querySelector('.app').appendChild(el);
    s.toastTimer = setTimeout(() => { el.remove(); if (s.toast === el) s.toast = null; }, 4000);
  }

  function chooseLang(btn) {
    const next = btn.dataset.lang;
    if (s.busy) return log(`запись идёт — щелчок по ${next} проигнорирован`);
    if (next === s.lang) return log(`${next} уже выбран — ничего`);
    s.busy = true;
    const group = btn.closest('.lang-switch');
    group.setAttribute('aria-busy', 'true');
    btn.classList.add('lang-switch__opt--pending');
    log(`запись language=${next}…`);
    setTimeout(() => {
      s.busy = false;
      if (page.write === 'fail') {
        group.removeAttribute('aria-busy'); btn.classList.remove('lang-switch__opt--pending');
        toast(strings(s.lang).fail);
        return log(`отказ записи — остаёмся на ${s.lang}`);
      }
      s.lang = next; render();
      frame.querySelector(`.lang-switch [data-lang="${next}"]`).focus({ preventScroll: true });
      log(`язык ${next} — выбран явно, запомнен`);
    }, page.write === 'slow' ? 1500 : 120);
  }

  frame.addEventListener('click', (e) => {
    const langBtn = e.target.closest('.lang-switch [data-lang]');
    if (langBtn) return chooseLang(langBtn);
    const p = e.target.closest('[data-param]:not([aria-disabled="true"]) .segment');
    if (p) {
      const key = p.parentElement.dataset.param;
      if (key in DEFAULTS && s[key] !== p.dataset.value) {
        s[key] = p.dataset.value; render();
        frame.querySelector(`[data-param="${key}"] [data-value="${p.dataset.value}"]`).focus({ preventScroll: true });
        log(`${key}=${p.dataset.value}`);
      }
      return;
    }
    const r = e.target.closest('[data-reset]');
    if (r && !r.disabled) {
      Object.assign(s, DEFAULTS); render();
      frame.querySelector('[data-reset]').focus({ preventScroll: true });
      log(`сброс параметров — язык остался ${s.lang}`);
    }
  });

  function boot() {
    if (s) { clearTimeout(s.toastTimer); if (s.toast) s.toast.remove(); }
    s = { lang: page.system, busy: false, ...DEFAULTS };
    document.getElementById('lv-log').innerHTML = '';
    render();
    log(`первый запуск: язык Windows ${page.system}-* → ${page.system}`);
  }

  function panelSeg(id, fn) {
    const g = document.getElementById(id);
    g.addEventListener('click', (e) => {
      const b = e.target.closest('.segment'); if (!b) return;
      for (const x of g.children) { const on = x === b; x.classList.toggle('segment--selected', on); x.setAttribute('aria-checked', on); }
      fn(b.dataset.value);
    });
  }
  panelSeg('lv-system', (v) => { page.system = v; boot(); });
  panelSeg('lv-write', (v) => { page.write = v; });
  panelSeg('lv-device', (v) => { page.device = v; render(); });
  panelSeg('lv-copy', (v) => { page.copy = v; render(); });
  document.getElementById('lv-restart').addEventListener('click', boot);
  boot();
})();
