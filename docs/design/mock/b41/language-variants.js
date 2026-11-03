// Варианты B-41: живой setup на двух языках, три размещения переключателя.
(() => {
  const T = {
    ru: {
      kicker: 'НОВОЕ СКАНИРОВАНИЕ', title: 'Сканируем обе стороны в два прохода',
      lead: 'Сначала лицевые стороны всех листов. Потом вы развернёте их на 180° — все разом, не переворачивая — и приложение само сопоставит обороты с лицами.',
      ready: 'готов', change: 'Сменить',
      color: 'Цвет', colorV: 'Оттенки серого', res: 'Разрешение', resT: 'обычный текст', size: 'Размер листа', sizeT: '210×297 мм',
      blanks: 'Пустые обороты', blanksO: [['hide', 'Скрывать', 'не попадут в файл'], ['mark', 'Помечать', 'останутся, но с меткой'], ['keep', 'Оставлять', 'сохранить всё как есть']],
      straight: 'Выравнивание', straightO: [['auto', 'Выравнивать', 'страницы, отсканированные с искажением, будут выпрямлены. Режим будет сохранён: новый выбор будет действовать со следующего сканирования'], ['off', 'Не трогать', 'страницы останутся как со сканера. Режим будет сохранён: новый выбор будет действовать со следующего сканирования']],
      reset: 'Сбросить параметры', launch: 'Сканировать лицевые стороны', hint: 'Положите листы в лоток лицом вверх, первая страница сверху',
      how: 'КАК ЭТО РАБОТАЕТ',
      steps: [['Лицевые стороны', 'Листы лицом вверх, первая страница сверху'], ['Разворот на 180°', 'Все листы разом, не переворачивая'], ['Обратная сторона', 'Приложение знает, что обороты идут в обратном порядке'], ['Проверка и сохранение', 'Порядок соберётся сам — проверьте его и сохраните документ']],
      lang: 'Язык', langCaps: 'ЯЗЫК', fail: 'Не удалось сохранить язык — попробуйте ещё раз',
    },
    en: {
      kicker: 'NEW SCAN', title: 'Scanning both sides in two passes',
      lead: 'First the front sides of all sheets. Then you turn them 180° — all at once, without flipping — and the app matches the backs to the fronts itself.',
      ready: 'ready', change: 'Change',
      color: 'Color', colorV: 'Grayscale', res: 'Resolution', resT: 'regular text', size: 'Paper size', sizeT: '210×297 mm',
      blanks: 'Blank backs', blanksO: [['hide', 'Hide', 'left out of the file'], ['mark', 'Mark', 'kept, but marked'], ['keep', 'Keep', 'save everything as is']],
      straight: 'Straightening', straightO: [['auto', 'Straighten', 'pages scanned with distortion will be straightened. The mode is remembered: a new choice applies from the next scan'], ['off', 'Leave as is', 'pages stay as they came from the scanner. The mode is remembered: a new choice applies from the next scan']],
      reset: 'Reset settings', launch: 'Scan the front sides', hint: 'Load the sheets into the tray face up, first page on top',
      how: 'HOW IT WORKS',
      steps: [['Front sides', 'Sheets face up, first page on top'], ['Turn 180°', 'All sheets at once, without flipping'], ['Back sides', 'The app knows the backs come in reverse order'], ['Check and save', 'The order comes together on its own — check it and save the document']],
      lang: 'Language', langCaps: 'LANGUAGE', fail: 'Couldn’t save the language — try again',
    },
  };
  const LANGS = [['ru', 'Русский'], ['en', 'English']];
  const DEFAULTS = { blanks: 'hide', straight: 'auto' };
  const page = { system: 'ru', write: 'ok' };
  const views = {};

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const seg = (name, key, opts, cur) =>
    `<div class="segments" role="radiogroup" aria-label="${esc(name)}" data-param="${key}">` +
    opts.map(([v, l, t]) => `<button type="button" role="radio" aria-checked="${v === cur}" data-value="${v}" class="segment${v === cur ? ' segment--selected' : ''}"${t ? ` title="${esc(t)}"` : ''}>${l}</button>`).join('') +
    '</div>';
  const row = (label, body) => `<div class="param-row"><div class="param-row__label">${label}</div>${body}</div>`;

  const langSegments = (t, cur) =>
    `<div class="segments lang-switch" role="radiogroup" aria-label="${t.lang}">` +
    LANGS.map(([v, l]) => `<button type="button" role="radio" lang="${v}" aria-checked="${v === cur}" data-lang="${v}" class="segment${v === cur ? ' segment--selected' : ''}">${l}</button>`).join('') +
    '</div>';

  const langText = (t, cur) =>
    `<div class="lang-switch lang-switch--aside" role="radiogroup" aria-label="${t.lang}"><span class="kicker" aria-hidden="true">${t.langCaps}</span><span class="lang-switch__opts">` +
    LANGS.map(([v, l]) => `<button type="button" role="radio" lang="${v}" aria-checked="${v === cur}" data-lang="${v}" class="lang-switch__opt">${l}</button>`).join('') +
    '</span></div>';

  function render(v) {
    const s = views[v], t = T[s.lang];
    const footer = v === 'b'
      ? `<div class="params__footer params__footer--lang"><button type="button" class="btn btn--ghost" data-reset>${t.reset}</button><div class="lang-switch--footer"><span class="lang-switch__label" aria-hidden="true">${t.lang}</span>${langSegments(t, s.lang)}</div></div>`
      : `<div class="params__footer"><button type="button" class="btn btn--ghost" data-reset>${t.reset}</button></div>`;
    const appGroup = v === 'a' ? `<div class="params params--app">${row(t.lang, langSegments(t, s.lang))}</div>` : '';
    const html =
      `<div class="ref-root"><div class="app"><div class="app__screen"><main class="setup-screen"><section class="setup-screen__column">` +
      `<header class="setup-screen__intro"><div class="kicker">${t.kicker}</div><h1 class="setup-screen__title">${t.title}</h1><p class="setup-screen__lead">${t.lead}</p></header>` +
      `<div class="params"><div class="device-row"><div class="device-row__name">ScanPro 200</div><div class="device-row__status"><span class="dot dot--ready" aria-hidden="true"></span><span class="device-row__status-text">${t.ready}</span></div><span class="device-row__spacer"></span><button type="button" class="btn btn--ghost">${t.change}</button></div>` +
      row(t.color, seg(t.color, 'color', [['g', t.colorV]], 'g')) +
      row(t.res, seg(t.res, 'res', [['300', '300 dpi', t.resT]], '300')) +
      row(t.size, seg(t.size, 'size', [['A4', 'A4', t.sizeT]], 'A4')) +
      row(t.blanks, seg(t.blanks, 'blanks', t.blanksO, s.blanks)) +
      row(t.straight, seg(t.straight, 'straight', t.straightO, s.straight)) +
      footer + `</div>` + appGroup +
      `<div class="setup-screen__launch"><button type="button" class="btn btn--primary btn--large">${t.launch}</button><p class="setup-screen__hint">${t.hint}</p></div></section>` +
      `<aside class="setup-screen__aside" aria-label="${t.how}"><div class="kicker">${t.how}</div><ol class="howto">` +
      t.steps.map(([a, b], i) => `<li class="howto__step"><span class="howto__num" aria-hidden="true">${i + 1}</span><span class="howto__body"><span class="howto__title">${a}</span><span class="howto__text">${b}</span></span></li>`).join('') +
      `</ol>${v === 'c' ? langText(t, s.lang) : ''}</aside></main></div></div></div>`;
    s.frame.setAttribute('lang', s.lang);
    s.frame.innerHTML = html;
    if (s.toast) s.frame.querySelector('.app').appendChild(s.toast);
  }

  function log(v, msg) {
    const ul = document.querySelector(`[data-log="${v}"]`);
    const li = document.createElement('li');
    li.textContent = msg;
    ul.prepend(li);
    while (ul.children.length > 4) ul.lastChild.remove();
  }

  function toast(v, text) {
    const s = views[v];
    clearTimeout(s.toastTimer);
    if (s.toast) s.toast.remove();
    const el = document.createElement('div');
    el.className = 'toast'; el.setAttribute('role', 'status'); el.textContent = text;
    s.toast = el;
    s.frame.querySelector('.app').appendChild(el);
    s.toastTimer = setTimeout(() => { el.remove(); if (s.toast === el) s.toast = null; }, 4000);
  }

  function chooseLang(v, btn) {
    const s = views[v], next = btn.dataset.lang;
    if (s.busy) { log(v, `занято — щелчок по ${next} проигнорирован`); return; }
    if (next === s.lang) { log(v, `${next} уже выбран — ничего`); return; }
    s.busy = true;
    const group = btn.closest('.lang-switch');
    group.setAttribute('aria-busy', 'true');
    btn.classList.add(btn.classList.contains('segment') ? 'segment--pending' : 'lang-switch__opt--pending');
    const ms = page.write === 'slow' ? 1500 : 120;
    log(v, `запись ${next}…`);
    setTimeout(() => {
      s.busy = false;
      if (page.write === 'fail') {
        group.removeAttribute('aria-busy');
        btn.classList.remove('segment--pending', 'lang-switch__opt--pending');
        toast(v, T[s.lang].fail);
        log(v, `отказ записи — остаёмся на ${s.lang}`);
        return;
      }
      s.lang = next; s.explicit = true;
      render(v);
      s.frame.querySelector(`.lang-switch [data-lang="${next}"]`).focus({ preventScroll: true });
      log(v, `язык ${next} (выбран явно)`);
    }, ms);
  }

  function onClick(v, e) {
    const s = views[v];
    const langBtn = e.target.closest('.lang-switch [data-lang]');
    if (langBtn) return chooseLang(v, langBtn);
    const p = e.target.closest('[data-param] .segment');
    if (p) {
      const key = p.parentElement.dataset.param;
      if (key in DEFAULTS) { s[key] = p.dataset.value; render(v); s.frame.querySelector(`[data-param="${key}"] [data-value="${p.dataset.value}"]`).focus({ preventScroll: true }); }
      return;
    }
    if (e.target.closest('[data-reset]')) {
      Object.assign(s, DEFAULTS); render(v);
      s.frame.querySelector('[data-reset]').focus({ preventScroll: true });
      log(v, `сброс параметров — язык остался ${s.lang}`);
    }
  }

  function boot() {
    for (const frame of document.querySelectorAll('.ref-frame[data-variant]')) {
      const v = frame.dataset.variant;
      const old = views[v];
      if (old) { clearTimeout(old.toastTimer); if (old.toast) old.toast.remove(); }
      views[v] = { frame, lang: page.system, explicit: false, busy: false, ...DEFAULTS };
      render(v);
      document.querySelector(`[data-log="${v}"]`).innerHTML = '';
      log(v, `старт: язык системы ${page.system}`);
      if (!old) frame.addEventListener('click', (e) => onClick(v, e));
    }
  }

  function panelSeg(id, fn) {
    const g = document.getElementById(id);
    g.addEventListener('click', (e) => {
      const b = e.target.closest('.segment'); if (!b) return;
      for (const x of g.children) { const on = x === b; x.classList.toggle('segment--selected', on); x.setAttribute('aria-checked', on); }
      fn(b.dataset.value);
    });
  }
  panelSeg('lv-system', (val) => { page.system = val; boot(); });
  panelSeg('lv-write', (val) => { page.write = val; });
  panelSeg('lv-scale', (val) => document.documentElement.style.setProperty('--lv-scale', val));
  document.getElementById('lv-restart').addEventListener('click', boot);
  boot();
})();
