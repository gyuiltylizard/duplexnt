(() => {
  const PAGES = '../reference/pages/';
  const OLD = { name: 'ScanPro 200', address: '192.0.2.10' };
  const EPSON = { name: 'EPSON ET-3850', address: '192.0.2.24' };
  const CONFIRM_SITS = ['cert', 'http', 'id'];
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  const T = {
    title: 'По этому адресу отвечает другое устройство',
    text: 'Это не тот сканер, что использовался раньше. Если подключить его, приложение забудет прежний и будет использовать это устройство.',
    replaceKey: 'ЗАМЕНИТ',
    replace: (n) => `сканер ${n}`,
    costInterrupted: 'Начатое на прежнем сканере сканирование продолжить будет нельзя. Полученные страницы останутся на месте.',
    costFlip: 'Лицевые стороны отсканированы на прежнем сканере, обороты придут с этого — документ соберётся с двух устройств. Ничего не потеряется, но качество сторон может отличаться.',
    confirm: 'Подключить это устройство',
    unnamed: 'Сканер без имени',
    connectingTo: (t) => `Подключаемся к ${t}…`,
    failStale: 'Не удалось подключиться: пока вы решали, приложение уже перепроверило адрес. Подключите ещё раз.',
    failBusy: 'Сменить сканер сейчас нельзя: идёт сканирование. Подключите этот сканер, когда оно закончится.',
    failSettings: 'Сканер подключён, но настройки не записались. После перезапуска приложение спросит о нём снова.',
    bannerGone: 'Полученные страницы на месте. Сканер, на котором начат проход, по этому адресу больше не отвечает — досканировать нельзя. Оставьте проход как есть или начните новое сканирование.',
  };

  let S;
  const reset = (keep = {}) => {
    const sit = keep.sit ?? 'cert';
    S = {
      screen: keep.screen ?? 'setup',
      sit,
      out: keep.out ?? 'ok',
      interrupted: keep.interrupted ?? true,
      unnamed: keep.unnamed ?? false,
      remembered: sit === 'first' ? null : { ...OLD },
      swapped: false,
      otherScanner: false,
      bannerAccepted: false,
      notice: null,
      resumeFailed: false,
      modal: null,
      toast: null,
      focus: null,
    };
  };
  reset();

  const needsConfirm = () => CONFIRM_SITS.includes(S.sit) && !S.swapped && S.remembered?.address === OLD.address;
  const probeName = () => (S.unnamed ? null : OLD.name);
  const listItems = () => [
    { name: probeName(), address: S.sit === 'moved' ? '192.0.2.31' : OLD.address, probe: true },
    { ...EPSON },
  ];
  const rowState = () => {
    if (!S.remembered) return 'none';
    if (needsConfirm()) return 'changed';
    if (S.sit === 'moved' && S.remembered.address === OLD.address) return 'unreachable';
    return 'ready';
  };
  const costFor = (entry) => {
    if (entry === 'flip') return 'flip';
    if (entry === 'editor') return 'interrupted';
    return S.interrupted && !S.bannerAccepted ? 'interrupted' : null;
  };

  /* — экраны — */
  function deviceRow() {
    const st = rowState();
    const r = S.remembered;
    if (st === 'none')
      return `<div class="device-row"><div class="device-row__none">Сканер не подключён</div><span class="device-row__spacer"></span><button type="button" class="btn btn--tinted" data-act="change" data-id="opener-change">+ Добавить сканер</button></div>`;
    if (st === 'changed')
      return `<div class="device-row device-row--changed"><div class="device-row__name">${esc(r.name || r.address)}</div><div class="device-row__status" title="По этому адресу отвечает другой сканер, не тот, что был запомнен"><span class="dot dot--warning" aria-hidden="true"></span><span class="device-row__status-text" role="status">по адресу другое устройство</span></div><span class="device-row__spacer"></span><button type="button" class="btn btn--ghost" data-act="reconnect" data-id="opener-reconnect">Подключить заново</button></div>`;
    if (st === 'unreachable')
      return `<div class="device-row device-row--unreachable"><div class="device-row__name">${esc(r.name)}</div><div class="device-row__status"><span class="dot dot--danger" aria-hidden="true"></span><span class="device-row__status-text">не отвечает</span></div><span class="device-row__spacer"></span><button type="button" class="btn btn--ghost" data-act="change" data-id="opener-change">Сменить</button></div>`;
    return `<div class="device-row"><div class="device-row__name">${esc(r.name || r.address)}</div><div class="device-row__status"><span class="dot dot--ready" aria-hidden="true"></span><span class="device-row__status-text">готов</span></div><span class="device-row__spacer"></span><button type="button" class="btn btn--ghost" data-act="change" data-id="opener-change">Сменить</button></div>`;
  }

  const param = (label, segs) =>
    `<div class="param-row"><div class="param-row__label">${label}</div><div class="segments" role="radiogroup" aria-label="${label}" ${rowState() !== 'ready' ? 'aria-disabled="true"' : ''}>${segs
      .map((s, i) => `<button type="button" role="radio" aria-checked="${i === 0}" class="segment ${i === 0 ? 'segment--selected' : ''}">${s}</button>`)
      .join('')}</div></div>`;

  const noticeHtml = () =>
    S.notice
      ? `<div class="notice notice--danger" role="alert"><p class="notice__text">Не удалось начать: по адресу сканера отвечает другое устройство.</p><button type="button" class="btn btn--tinted" data-act="reconnect-${S.screen}" data-id="opener-notice">Подключить заново</button></div>`
      : '';

  function setup() {
    return `<main class="setup-screen"><section class="setup-screen__column"><header class="setup-screen__intro"><div class="kicker">НОВОЕ СКАНИРОВАНИЕ</div><h1 class="setup-screen__title">Сканируем обе стороны в два прохода</h1><p class="setup-screen__lead">Сначала лицевые стороны всех листов. Потом вы развернёте их на 180° — все разом, не переворачивая — и приложение само сопоставит обороты с лицами.</p></header>
      <div class="params">${deviceRow()}${param('Цвет', ['Оттенки серого'])}${param('Разрешение', ['300 dpi'])}${param('Размер листа', ['A4'])}${param('Пустые обороты', ['Скрывать', 'Помечать', 'Оставлять'])}${param('Выравнивание', ['Выравнивать', 'Не трогать'])}<div class="params__footer"><button type="button" class="btn btn--ghost">Сбросить параметры</button></div></div>
      <div class="setup-screen__launch"><button type="button" class="btn btn--primary btn--large" data-act="launch">Сканировать лицевые стороны</button><p class="setup-screen__hint">Положите листы в лоток лицом вверх, первая страница сверху</p>${noticeHtml()}</div></section>
      <aside class="setup-screen__aside" aria-label="КАК ЭТО РАБОТАЕТ"><div class="kicker">КАК ЭТО РАБОТАЕТ</div><ol class="howto">${[
        ['Лицевые стороны', 'Листы лицом вверх, первая страница сверху'],
        ['Разворот на 180°', 'Все листы разом, не переворачивая'],
        ['Обратная сторона', 'Приложение знает, что обороты идут в обратном порядке'],
        ['Проверка и сохранение', 'Порядок соберётся сам — проверьте его и сохраните документ'],
      ]
        .map((s, i) => `<li class="howto__step"><span class="howto__num" aria-hidden="true">${i + 1}</span><span class="howto__body"><span class="howto__title">${s[0]}</span><span class="howto__text">${s[1]}</span></span></li>`)
        .join('')}</ol></aside></main>`;
  }

  function flip() {
    const checks = [
      'Проверьте входной лоток: в нём не должно остаться листов. Оставшийся лист не отсканирован.',
      'Не переворачивайте листы — из податчика они вышли оборотами вверх.',
      'Не меняйте порядок листов: обороты придут в обратном порядке, приложение это учтёт.',
      'Если один лист застрял — начните второй проход и вставьте его отдельно.',
    ];
    return `<main class="flip-screen" tabindex="-1"><header class="flip-screen__intro"><div class="kicker">ШАГ 2 ИЗ 3 · ЛИЦА ГОТОВЫ: 6 листов</div><h1 class="flip-screen__title">Разверните листы на 180° — все разом</h1><p class="flip-screen__lead">Переворачивать не нужно: из податчика листы вышли оборотами вверх. Возьмите все листы разом, разверните на 180° и положите обратно в лоток.</p></header>
      <div class="flip-screen__card"><div class="flip-screen__demo"><div class="turn" aria-hidden="true"><div class="turn__shadows"><span class="turn__sheet turn__sheet--under"></span><span class="turn__sheet turn__sheet--mid"></span></div><div class="turn__front"><span class="turn__arrow">↑</span><span class="turn__top">ВЕРХ</span><span class="turn__lines"><span class="turn__line turn__line--1"></span><span class="turn__line turn__line--2"></span><span class="turn__line turn__line--3"></span></span></div><span class="turn__tray"></span></div><div class="flip-screen__caption">все листы разом —<br>разворот на 180°</div></div><div class="flip-screen__divider" aria-hidden="true"></div><ol class="flip-screen__checklist">${checks
        .map((c) => `<li class="flip-screen__check"><span class="flip-screen__checkbox" aria-hidden="true">✓</span><span class="flip-screen__check-text">${c}</span></li>`)
        .join('')}</ol></div>
      <div class="flip-screen__actions"><button type="button" class="btn btn--primary btn--large" data-act="launch">Листы в лотке — сканировать обороты</button><button type="button" class="btn btn--link">Обороты не нужны</button></div>${S.notice ? `<div style="width:560px">${noticeHtml()}</div>` : ''}</main>`;
  }

  function banner() {
    if (!S.interrupted || S.bannerAccepted) return '';
    let kind = 'normal';
    if (S.swapped) kind = 'gone';
    else if (needsConfirm() || S.otherScanner) kind = 'other';
    const passName = OLD.name;
    const text = {
      normal: 'Полученные страницы на месте. Чтобы досканировать, положите в лоток оставшиеся листы, начиная с 5-го, и нажмите «Досканировать остаток».',
      other: `Полученные страницы на месте. Досканировать можно только на том сканере, на котором начат проход: ${passName}. Подключите его в настройках — или оставьте проход как есть.`,
      gone: T.bannerGone,
    }[kind];
    const resume = kind === 'gone' ? '' : `<button type="button" class="btn btn--primary btn--small" data-act="resume">Досканировать остаток</button>`;
    const status =
      kind === 'other'
        ? `<p class="pass-banner__status ${S.resumeFailed ? 'pass-banner__status--danger' : ''}" ${S.resumeFailed ? 'role="alert"' : ''}>${S.resumeFailed ? 'Досканировать не удалось: по адресу сканера отвечает другое устройство. ' : 'По адресу сканера отвечает другое устройство — '}<button type="button" class="btn btn--link" data-act="reconnect-editor" data-id="opener-banner">подключите заново</button>.</p>`
        : '';
    return `<div class="pass-banner" role="region" aria-labelledby="pass-banner-title"><div class="pass-banner__kicker"><span class="dot dot--warning" aria-hidden="true"></span><span class="kicker kicker--warning">ПРОХОД ПРЕРВАН</span></div><h2 id="pass-banner-title" class="pass-banner__title">Проход прервался после страницы 4</h2><p class="pass-banner__text">${text}</p><div class="pass-banner__actions">${resume}<button type="button" class="btn btn--tinted" data-act="accept" ${kind === 'gone' ? 'data-id="banner-first"' : ''}>Оставить как есть</button><button type="button" class="btn btn--ghost" data-act="newscan">Новое сканирование</button></div>${status}</div>`;
  }

  function editor() {
    const thumbs = [1, 2, 3, 4]
      .map(
        (n) =>
          `<li role="option" aria-selected="${n === 1}" aria-label="Страница ${n}" tabindex="${n === 1 ? 0 : -1}" class="thumb ${n === 1 ? 'thumb--selected' : ''}"><div class="thumb__paper"><img class="thumb__img" alt="" src="${PAGES}page-0${n * 2 - 1}.jpg"></div><div class="thumb__foot"><span class="thumb__num">${n}</span></div></li>`,
      )
      .join('');
    return `<main class="editor-screen"><header class="editor-screen__toolbar"><div class="editor-screen__toolbar-left"><button type="button" class="btn btn--secondary" data-act="newscan"><span aria-hidden="true">↺</span> Новый скан</button><button type="button" class="btn btn--secondary editor-screen__add"><span class="editor-screen__add-plus" aria-hidden="true">+</span> Добавить листы</button></div><div class="editor-screen__toolbar-center doc-tone--1"><span class="editor-screen__doc-mark" aria-hidden="true"></span><span class="editor-screen__doc-title">Документ 1</span><span class="editor-screen__doc-pos">стр. 1 из 4</span></div><div class="editor-screen__toolbar-right"><button type="button" class="btn btn--primary btn--small">Сохранить</button></div></header>
      <div class="editor-screen__body"><aside class="rail" aria-label="Отсканированные страницы"><div class="rail__scroll"><section class="doc-group doc-tone--1"><div class="doc-group__header"><span class="doc-badge" aria-hidden="true">1</span><input class="doc-group__name" placeholder="Документ 1" aria-label="Название документа 1" type="text" value=""><span class="doc-group__count">4 стр.</span></div><ul class="thumbs" role="listbox" aria-label="Страницы документа 1">${thumbs}</ul></section></div></aside>
      <section class="stage">${banner()}<div class="preview"><div class="preview__paper doc-tone--1"><img class="preview__img" alt="Страница 1" src="${PAGES}page-01.jpg"></div></div><footer class="stage__statusbar"><button type="button" class="btn btn--icon" aria-label="Предыдущая страница" aria-disabled="true">←</button><div class="stage__counter">1 из 4</div><button type="button" class="btn btn--icon" aria-label="Следующая страница">→</button></footer></section>
      <aside class="inspector" aria-label="Сведения о наборе"><section class="inspector__section"><h2 class="kicker">ПРОВЕРКА</h2><ul class="checks"><li class="check"><span class="check__icon" aria-hidden="true">✓</span><span class="check__text">Получено 4 лицевые стороны</span></li></ul></section></aside></div></main>`;
  }

  /* — модалка device + шаг — */
  function modal() {
    const m = S.modal;
    if (!m) return '';
    const confirming = m.mode === 'confirm' || m.mode === 'busy';
    const busy = m.mode === 'busy';
    const items = listItems()
      .map((it, i) => {
        const sel = m.selected === i;
        return `<div role="option" aria-selected="${sel}" tabindex="${confirming ? -1 : 0}" class="device-item ${sel ? 'device-item--selected' : ''}" data-act="pick" data-i="${i}"><div class="device-item__main"><div class="device-item__name ${it.name ? '' : 'device-item__name--unnamed'}">${esc(it.name || T.unnamed)}</div><div class="device-item__address">${it.address}:443</div></div><div class="device-item__status">готов</div></div>`;
      })
      .join('');
    const p = m.probe;
    const cost = m.cost === 'flip' ? T.costFlip : m.cost === 'interrupted' ? T.costInterrupted : '';
    const described = 'dc-text dc-replace' + (cost ? ' dc-cost' : '');
    const step = confirming
      ? `<div class="device-confirm ${m.enter ? 'device-confirm--enter' : ''}" role="alertdialog" aria-labelledby="dc-title" aria-describedby="${described}">
          <h3 class="device-confirm__title" id="dc-title">${T.title}</h3>
          <div class="device-confirm__who"><span class="device-confirm__name ${p.name ? '' : 'device-confirm__name--unnamed'}">${esc(p.name || T.unnamed)}</span><span class="device-confirm__address">${p.address}</span></div>
          <p class="device-confirm__text" id="dc-text">${T.text}</p>
          <p class="device-confirm__replace" id="dc-replace"><span class="device-confirm__replace-key">${T.replaceKey}</span><span>${esc(T.replace(OLD.name))}</span></p>
          ${cost ? `<p class="device-confirm__cost" id="dc-cost">${cost}</p>` : ''}
        </div>`
      : '';
    const status = busy ? T.connectingTo(m.probe.name || m.probe.address) : m.status || (confirming ? '' : 'Найдено 2 устройства · поиск продолжается');
    return `<div class="modal-overlay" data-act="overlay"><section role="dialog" aria-modal="true" aria-labelledby="device-title" tabindex="-1" class="modal device-modal ${confirming ? 'device-modal--confirming' : ''}" ${busy ? 'aria-busy="true"' : ''}>
      <header class="modal__header"><h2 id="device-title" class="modal__title">Добавить сканер</h2></header>
      <div class="modal__body">
        <div class="device-modal__pick" ${confirming ? 'aria-hidden="true"' : ''}>
          <div class="modal__section device-modal__list"><div class="kicker">СЕТЕВЫЕ СКАНЕРЫ</div><div class="device-list" role="listbox" aria-label="Сетевые сканеры">${items}</div></div>
          <div class="modal__section" style="margin-top:var(--space-9)"><div class="kicker">АДРЕС ВРУЧНУЮ</div><input class="input" data-id="addr" placeholder="адрес сканера в сети" aria-label="АДРЕС ВРУЧНУЮ" value="${esc(m.input)}" ${confirming ? 'disabled' : ''} /><button type="button" class="device-advanced__toggle" aria-expanded="false" tabindex="${confirming ? -1 : 0}">Дополнительно<span aria-hidden="true">▾</span></button></div>
        </div>
        ${step}
      </div>
      <footer class="modal__footer"><p class="modal__status ${m.danger && !busy ? 'modal__status--danger' : ''}" role="status">${esc(status)}</p>
        <button type="button" class="btn btn--ghost" data-act="cancel" data-id="cancel">Отмена</button>
        <button type="button" class="btn btn--primary" data-act="primary" ${busy ? 'aria-disabled="true"' : ''}>${confirming ? T.confirm : 'Подключить'}</button>
      </footer></section></div>`;
  }

  /* — рендер — */
  const app = document.getElementById('cs-app');
  const note = document.getElementById('cs-note');
  const log = document.getElementById('cs-log');
  function render() {
    const screen = { setup, flip, editor }[S.screen]();
    app.innerHTML = `<div class="app__screen">${screen}</div>${modal()}${S.toast ? `<div class="toast" role="status">${esc(S.toast)}</div>` : ''}`;
    if (S.modal) S.modal.enter = false;
    if (S.focus) {
      app.querySelector(`[data-id="${S.focus}"]`)?.focus();
      S.focus = null;
    }
    document.querySelectorAll('#cs-screens [data-screen]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.screen === S.screen));
    note.textContent = {
      setup: 'setup — входы: «Подключить заново» в строке устройства (адрес уже в поле) и «Сменить» (выбор в списке). Запуск при чужом устройстве — плашка с «Подключить заново».',
      flip: 'flip — «Листы в лотке…» при чужом устройстве даёт плашку отказа; её «Подключить заново» ведёт в шаг с ценой «документ с двух устройств».',
      editor: 'editor с прерванным проходом — до смены плашка со ссылкой «подключите заново»; после подтверждения — вариант без ссылки и без «Досканировать остаток».',
    }[S.screen];
    log.textContent = [
      `запомнен: ${S.remembered ? `${S.remembered.name || T.unnamed} · ${S.remembered.address}` : '—'}`,
      `строка setup: ${rowState()}`,
      `модалка: ${S.modal ? S.modal.mode + (S.modal.cost ? ' · цена ' + S.modal.cost : '') : 'закрыта'}`,
      `подключений: ${S.connects ?? 0}`,
    ].join('\n');
  }

  let toastTimer;
  const toast = (t) => {
    S.toast = t;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      S.toast = null;
      render();
    }, 3200);
  };

  function openModal(entry, prefill, opener) {
    S.notice = null;
    S.modal = { entry, cost: costFor(entry), mode: 'input', input: prefill ? OLD.address : '', selected: null, status: '', danger: false, opener };
    S.focus = 'addr';
    render();
  }
  function closeModal() {
    const opener = S.modal?.opener;
    clearTimeout(S.modal?.timer);
    S.modal = null;
    S.focus = opener;
    render();
  }
  function success(target, viaConfirm) {
    S.connects = (S.connects ?? 0) + 1;
    S.remembered = { name: target.name, address: target.address };
    if (viaConfirm) S.swapped = true;
    else S.otherScanner = target.address === EPSON.address;
    S.notice = null;
    S.resumeFailed = false;
    S.modal = null;
    S.focus = S.screen === 'editor' && S.swapped ? 'banner-first' : null;
    toast(`Сканер подключён: ${target.name || target.address}`);
    render();
  }

  function connect() {
    const m = S.modal;
    const items = listItems();
    const target = m.selected != null ? items[m.selected] : m.input.trim() ? { address: m.input.trim().replace(/:\d+$/, ''), name: null } : null;
    if (!target) return Object.assign(m, { status: 'Выберите сканер в списке или введите адрес', danger: true }), render();
    const known = items.find((it) => it.address === target.address);
    if (!known) return Object.assign(m, { status: 'Не удалось подключиться: по этому адресу никто не отвечает.', danger: true }), render();
    if (known.address === OLD.address && needsConfirm()) {
      Object.assign(m, { mode: 'confirm', probe: known, status: '', danger: false, enter: true });
      S.focus = 'cancel';
      return render();
    }
    m.mode = 'busy';
    m.probe = known;
    render();
    m.timer = setTimeout(() => success(known, false), 900);
  }

  function confirmStep() {
    const m = S.modal;
    m.mode = 'busy';
    render();
    m.timer = setTimeout(() => {
      const out = S.out;
      if (out === 'ok') return success(m.probe, true);
      if (out === 'settings') {
        S.connects = (S.connects ?? 0) + 1;
        S.remembered = { name: m.probe.name, address: m.probe.address };
        S.swapped = true;
      }
      const text = { stale: T.failStale, superseded: T.failStale, busy: T.failBusy, settings: T.failSettings }[out];
      Object.assign(m, { mode: 'input', status: text, danger: true });
      S.focus = 'addr';
      render();
    }, 1200);
  }

  app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const m = S.modal;
    if (act === 'overlay') return; // клик по подложке модалку не закрывает
    e.stopPropagation();
    if (act === 'change') return openModal('setup', false, 'opener-change');
    if (act === 'reconnect') return openModal('setup', true, 'opener-reconnect');
    if (act === 'reconnect-setup') return openModal('setup', true, 'opener-notice');
    if (act === 'reconnect-flip') return openModal('flip', true, 'opener-notice');
    if (act === 'reconnect-editor') return openModal('editor', true, 'opener-banner');
    if (act === 'launch') {
      if (rowState() !== 'ready') S.notice = true;
      else toast(S.screen === 'flip' ? 'Мок: начался проход оборотов' : 'Мок: начался проход лицевых сторон');
      return render();
    }
    if (act === 'resume') {
      if (needsConfirm() || S.otherScanner) S.resumeFailed = true;
      else toast('Мок: досканирование началось');
      return render();
    }
    if (act === 'accept') return (S.bannerAccepted = true), render();
    if (act === 'newscan') return (S.screen = 'setup'), (S.notice = null), render();
    if (!m) return;
    if (act === 'pick' && m.mode === 'input') return Object.assign(m, { selected: +el.dataset.i, input: '', status: '', danger: false }), render();
    if (m.mode === 'busy') {
      if (act === 'cancel') {
        clearTimeout(m.timer);
        Object.assign(m, { mode: 'input', status: 'Подключение отменено', danger: false });
        S.focus = 'addr';
        render();
      }
      return; // повторное нажатие во время ожидания — ничего
    }
    if (act === 'primary') return m.mode === 'confirm' ? confirmStep() : connect();
    if (act === 'cancel') {
      if (m.mode === 'confirm') {
        Object.assign(m, { mode: 'input', status: '', danger: false });
        S.focus = m.selected != null ? null : 'addr';
        return render();
      }
      return closeModal();
    }
  });
  app.addEventListener('input', (e) => {
    if (e.target.dataset.id === 'addr' && S.modal) {
      S.modal.input = e.target.value;
      if (S.modal.selected != null) {
        S.modal.selected = null;
        S.focus = 'addr';
        render();
        const i = app.querySelector('[data-id="addr"]');
        i.setSelectionRange(i.value.length, i.value.length);
      }
    }
  });
  app.addEventListener('keydown', (e) => {
    if (!S.modal) return;
    if (e.key === 'Escape') return closeModal();
    if (e.key === 'Enter' && e.target.dataset.id === 'addr') connect();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.modal && !app.contains(document.activeElement)) closeModal();
  });

  /* — панель — */
  document.getElementById('cs-screens').addEventListener('click', (e) => {
    const b = e.target.closest('[data-screen]');
    if (!b) return;
    S.screen = b.dataset.screen;
    S.notice = null;
    S.modal = null;
    render();
  });
  const fixture = () => ({
    screen: S.screen,
    sit: document.querySelector('input[name="sit"]:checked').value,
    out: document.querySelector('input[name="out"]:checked').value,
    interrupted: document.getElementById('cs-interrupted').checked,
    unnamed: document.getElementById('cs-unnamed').checked,
  });
  document.getElementById('cs-situation').addEventListener('change', () => (reset(fixture()), render()));
  document.getElementById('cs-outcome').addEventListener('change', () => (S.out = fixture().out));
  document.getElementById('cs-interrupted').addEventListener('change', (e) => ((S.interrupted = e.target.checked), (S.bannerAccepted = false), render()));
  document.getElementById('cs-unnamed').addEventListener('change', (e) => ((S.unnamed = e.target.checked), S.modal?.probe && (S.modal.probe = listItems()[0]), render()));
  document.getElementById('cs-reset').addEventListener('click', () => (reset(fixture()), render()));
  const reduce = document.getElementById('cs-reduce');
  reduce.addEventListener('change', () => document.body.classList.toggle('cs-reduced', reduce.checked));

  render();
})();
