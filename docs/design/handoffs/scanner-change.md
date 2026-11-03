# Handoff — подтверждение смены устройства в модалке `device` (B-29)

Шаг подтверждения внутри модалки `device`. Он появляется, когда ядро на «Подключить» отвечает
«нужно подтверждение»: по адресу запомненного сканера отвечает не то устройство (новый
сертификат, HTTP вместо HTTPS, другой идентификатор). Закрывает бриф
`briefs/scanner-change.md`. Плюс новый вариант плашки прерванного прохода в `editor` — после
подтверждённой замены. Форма выбрана на странице вариантов (`mock/scanner-change-variants.html`,
вариант **1b — карточка над футером**) и утверждена в моке `mock/scanner-change.html`
2026-11-02.

## Placement

- **`device` (UI_SPEC §7.1).** Модалка та же, второй модалки нет. На время шага:
  - секция СЕТЕВЫЕ СКАНЕРЫ и «Дополнительно» (кнопка и раскрытая панель) скрываются
    (`display: none`);
  - поле АДРЕС ВРУЧНУЮ остаётся на месте — приглушённое, `disabled`, с прежним вводом;
  - под ним, последним элементом `.modal__body`, — карточка `.device-confirm`;
  - футер прежний: «Отмена» и первичная кнопка, у которой меняется только текст;
  - высота модалки меньше, чем в режиме ввода, — прокрутки нет при любой длине списка и
    любой строке последствий.
- **`editor` · `.pass-banner` (S17).** Новый текст `editor.interrupted.textReplaced` — без
  ссылки и без «Досканировать остаток».
- **Вход с `setup`.** «Подключить заново» в строке S4 и «Подключить заново» в плашке S6 — без
  изменений (адрес запомненного уже в поле); «Сменить» — без изменений.
- **Вход с `flip`.** Отказ запуска второго прохода с `scannerCertificateChanged` показывает ту
  же плашку `.notice--danger` с тонированной «Подключить заново», что S6 на `setup`.
- **Вход из `editor`.** Ссылка «подключите заново» в плашке прерванного прохода.

## Anatomy

```html
<section
  role="dialog"
  aria-modal="true"
  aria-labelledby="device-title"
  tabindex="-1"
  class="modal device-modal device-modal--confirming"
>
  <header class="modal__header">
    <h2 id="device-title" class="modal__title">Добавить сканер</h2>
  </header>
  <div class="modal__body">
    <div class="device-modal__pick" aria-hidden="true">
      <div class="modal__section device-modal__list">…список — скрыт…</div>
      <div class="modal__section">
        <div class="kicker">АДРЕС ВРУЧНУЮ</div>
        <input class="input" value="192.0.2.10" disabled aria-label="АДРЕС ВРУЧНУЮ" />
        <button type="button" class="device-advanced__toggle" tabindex="-1">…скрыт…</button>
      </div>
    </div>

    <div
      class="device-confirm"
      role="alertdialog"
      aria-labelledby="device-confirm-title"
      aria-describedby="device-confirm-text device-confirm-replace device-confirm-cost"
    >
      <h3 class="device-confirm__title" id="device-confirm-title">
        По этому адресу отвечает другое устройство
      </h3>
      <div class="device-confirm__who">
        <span class="device-confirm__name">ScanPro 200</span>
        <!-- без имени: <span class="device-confirm__name device-confirm__name--unnamed">Сканер без имени</span> -->
        <span class="device-confirm__address">192.0.2.10</span>
      </div>
      <p class="device-confirm__text" id="device-confirm-text">
        Это не тот сканер, что использовался раньше. …
      </p>
      <p class="device-confirm__replace" id="device-confirm-replace">
        <span class="device-confirm__replace-key">ЗАМЕНИТ</span><span>сканер ScanPro 200</span>
      </p>
      <!-- только при цене смены; иначе элемента нет и id убирается из aria-describedby -->
      <p class="device-confirm__cost" id="device-confirm-cost">Начатое на прежнем сканере …</p>
    </div>
  </div>
  <footer class="modal__footer">
    <p class="modal__status" role="status"></p>
    <button type="button" class="btn btn--ghost">Отмена</button>
    <!-- начальный фокус -->
    <button type="button" class="btn btn--primary">Подключить это устройство</button>
  </footer>
</section>
```

Ожидание: на `.modal` — `aria-busy="true"`, на первичной — `aria-disabled="true"`, в
`.modal__status` — `device.connectingTo`.

Плашка после замены (S17, новый вариант):

```html
<div class="pass-banner" role="region" aria-labelledby="pass-banner-title">
  <div class="pass-banner__kicker">
    <span class="dot dot--warning" aria-hidden="true"></span
    ><span class="kicker kicker--warning">ПРОХОД ПРЕРВАН</span>
  </div>
  <h2 id="pass-banner-title" class="pass-banner__title">Проход прервался после страницы 4</h2>
  <p class="pass-banner__text">{{editor.interrupted.textReplaced}}</p>
  <div class="pass-banner__actions">
    <button type="button" class="btn btn--tinted">Оставить как есть</button>
    <button type="button" class="btn btn--ghost">Новое сканирование</button>
  </div>
</div>
```

## Tokens

Новых токенов нет. Используются `--color-warning` (рамка карточки, ключ «ЗАМЕНИТ», строка
последствий), `--color-bg-surface`, `--color-border-subtle`, `--opacity-disabled`,
`--duration-fast`, `--ease-standard`.

## CSS

```css
.device-modal--confirming .device-modal__pick {
  opacity: var(--opacity-disabled);
  pointer-events: none;
}
.device-modal--confirming .device-modal__list,
.device-modal--confirming .device-advanced__toggle,
.device-modal--confirming .device-advanced {
  display: none;
}

.device-confirm {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: var(--space-7) var(--space-8);
  background: var(--color-bg-surface);
  border: var(--border-width) solid var(--color-warning);
  border-radius: var(--radius-l);
}
.device-confirm__title {
  margin: 0;
  font-weight: var(--font-weight-semibold);
  font-size: var(--font-size-base);
  line-height: var(--leading-snug);
}
.device-confirm__who {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-5);
}
.device-confirm__name {
  flex: none;
  max-width: 100%;
  font-weight: var(--font-weight-semibold);
  font-size: var(--font-size-base);
  line-height: var(--leading-snug);
  overflow-wrap: anywhere;
}
.device-confirm__name--unnamed {
  font-weight: var(--font-weight-medium);
  color: var(--color-text-muted);
}
.device-confirm__address {
  font: var(--font-weight-regular) var(--font-size-m) / var(--leading-snug) var(--font-family-mono);
  color: var(--color-text-muted);
}
.device-confirm__text {
  margin: 0;
  font-size: var(--font-size-m);
  line-height: var(--leading-relaxed);
  color: var(--color-text-secondary);
  text-wrap: pretty;
}
.device-confirm__replace {
  display: flex;
  align-items: baseline;
  gap: var(--space-4);
  margin: 0;
  font-size: var(--font-size-m);
  line-height: var(--leading-relaxed);
  color: var(--color-text-primary);
}
.device-confirm__replace-key {
  flex: none;
  font: var(--font-weight-medium) var(--font-size-xs) / 1 var(--font-family-mono);
  letter-spacing: var(--tracking-caps);
  color: var(--color-warning);
}
.device-confirm__cost {
  margin: 0;
  padding-top: var(--space-4);
  border-top: var(--border-width) solid var(--color-border-subtle);
  font-size: var(--font-size-m);
  line-height: var(--leading-relaxed);
  color: var(--color-warning);
  text-wrap: pretty;
}

.device-confirm--enter {
  animation: device-confirm-in var(--duration-fast) var(--ease-standard) both;
}
@keyframes device-confirm-in {
  from {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .device-confirm--enter {
    animation: none;
  }
}
```

## States

| Состояние                  | Когда                                                                                                         | Что меняется                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ввод                       | модалка открыта, шага нет                                                                                     | как сейчас (§7.1)                                                                                                                                               |
| шаг                        | ответ ядра «нужно подтверждение»                                                                              | `device-modal--confirming`; список и «Дополнительно» скрыты, поле `disabled`; карточка; первичная — «Подключить это устройство»; статус пуст; фокус на «Отмене» |
| шаг · без цены             | вход с `setup`, прерванного прохода нет                                                                       | карточка без `.device-confirm__cost`                                                                                                                            |
| шаг · прерванный проход    | вход из `editor` или с `setup` при прерванном проходе                                                         | строка `device.confirm.costInterrupted`                                                                                                                         |
| шаг · `flip`               | вход с `flip`                                                                                                 | строка `device.confirm.costFlip` (оба варианта сразу не встречаются)                                                                                            |
| шаг · без имени            | в ответе нет имени                                                                                            | `device.confirm.unnamed`, модификатор `--unnamed`                                                                                                               |
| ожидание                   | после «Подключить это устройство»                                                                             | `aria-busy` на модалке, тело приглушено (существующее правило), первичная `aria-disabled`, статус `device.connectingTo`                                         |
| отказ                      | ядро отклонило подтверждение                                                                                  | шаг исчезает → ввод с нетронутым полем, текст отказа в `.modal__status--danger`, фокус в поле                                                                   |
| успех                      | подключено                                                                                                    | модалка закрыта, тост `toast.connected`, строка `setup` «готов»                                                                                                 |
| плашка · другое устройство | прерванный проход, по адресу чужое устройство (до подтверждения) или подключён другой сканер на другом адресе | прежний `textOtherScanner` со ссылкой «подключите заново»                                                                                                       |
| плашка · заменено          | прерванный проход, замена на том же адресе подтверждена                                                       | `textReplaced`; нет «Досканировать остаток» и ссылки; фокус на «Оставить как есть»                                                                              |

## Behaviour

- **Когда появляется шаг.** Его включает только ответ ядра «нужно подтверждение» с набором
  последствий. Renderer причин не различает: первое подключение, тот же сканер на новом
  адресе и другой сканер на другом адресе подключаются как раньше, без шага.
- **Последствия** пришли от ядра: строка цены — по ним, а не по экрану. Экран входа задаёт
  только текст: из `flip` — `costFlip`, иначе `costInterrupted`.
- **Подтвердить.** «Подключить это устройство» → ожидание. Второе нажатие и Enter во время
  ожидания ничего не делают: одно подключение на шаг. Успех — как у обычного подключения:
  модалка закрывается, тост «Сканер подключён: {{name}}» (у безымянного — адрес), фокус
  возвращается к элементу, открывшему модалку. Исключение — в `editor` при смене плашки:
  фокус на «Оставить как есть». Отдельного тоста «прежний сканер забыт» нет.
- **Отмена в шаге.** Шаг исчезает, список и «Дополнительно» возвращаются, поле — с прежним
  вводом (выбор в списке тоже сохраняется), статус пуст, фокус в поле. Запомненный сканер не
  меняется.
- **Отмена во время ожидания** отменяет подключение, как сейчас (S10): возврат к вводу.
- **Esc** закрывает модалку из любого состояния, включая шаг и ожидание (ожидание
  отменяется). Прежний сканер остаётся запомненным; строка `setup` — по-прежнему «по адресу
  другое устройство» с «Подключить заново». Нового состояния строки нет.
- **Отказы подтверждения.** После каждого — шаг исчезает, возврат к вводу с нетронутым полем,
  текст в статусной строке красным:
  - проба устарела и ответ уже не актуален → `device.confirm.failStale`;
  - идёт сканирование → `device.confirm.failBusy`;
  - настройки не записались → `device.confirm.failSettings`. Сканер подключён до перезапуска:
    строка `setup` «готов», плашка `editor` — вариант «заменено».
- **Клавиатура.** Начальный фокус на «Отмене» — Enter по привычке подтверждение не
  проскакивает. Tab внутри шага: «Отмена» → «Подключить это устройство». Скрытые и `disabled`
  элементы из Tab выпадают.
- **Скринридер.** Карточка `role="alertdialog"`: при появлении объявляется заголовок, затем
  `aria-describedby` — текст, «ЗАМЕНИТ …» и строка цены. Название действия самодостаточно:
  «Подключить это устройство», а не «Да».
- **Плашка прерванного прохода.** Вариант выбирается так:
  - замена на том же адресе подтверждена → `textReplaced` с действиями «Оставить как есть» и
    «Новое сканирование»;
  - по адресу чужое устройство (до подтверждения) или подключён другой сканер на другом
    адресе → прежний `textOtherScanner` со ссылкой.
- **Движение.** Появление карточки — проявление `opacity 0 → 1`, 150 мс
  (`--duration-fast`, `--ease-standard`). Исчезновение и возврат к вводу — без анимации, сразу.
  Под `prefers-reduced-motion` — без движения.

## Copy

| Ключ (предложение)                | ru                                                                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device.confirm.title`            | По этому адресу отвечает другое устройство                                                                                                                                         |
| `device.confirm.text`             | Это не тот сканер, что использовался раньше. Если подключить его, приложение забудет прежний и будет использовать это устройство.                                                  |
| `device.confirm.replaceKey`       | ЗАМЕНИТ                                                                                                                                                                            |
| `device.confirm.replace`          | сканер {{name}}                                                                                                                                                                    |
| `device.confirm.unnamed`          | Сканер без имени                                                                                                                                                                   |
| `device.confirm.costInterrupted`  | Начатое на прежнем сканере сканирование продолжить будет нельзя. Полученные страницы останутся на месте.                                                                           |
| `device.confirm.costFlip`         | Лицевые стороны отсканированы на прежнем сканере, обороты придут с этого — документ соберётся с двух устройств. Ничего не потеряется, но качество сторон может отличаться.         |
| `device.confirm.action`           | Подключить это устройство                                                                                                                                                          |
| `device.confirm.failStale`        | Не удалось подключиться: пока вы решали, приложение уже перепроверило адрес. Подключите ещё раз.                                                                                   |
| `device.confirm.failBusy`         | Сменить сканер сейчас нельзя: идёт сканирование. Подключите этот сканер, когда оно закончится.                                                                                     |
| `device.confirm.failSettings`     | Сканер подключён, но настройки не записались. После перезапуска приложение спросит о нём снова.                                                                                    |
| `editor.interrupted.textReplaced` | Полученные страницы на месте. Сканер, на котором начат проход, по этому адресу больше не отвечает — досканировать нельзя. Оставьте проход как есть или начните новое сканирование. |

Существующие строки без изменений: `device.connectingTo`, `toast.connected`,
`setup.device.status.changed`, `setup.device.reconnect`, `editor.interrupted.textOtherScanner`,
`editor.interrupted.reconnect`.

## Decisions and open questions

- **Решено:** шаг — карточка над футером при остающемся поле адреса (1b). Отклонены:
  - 1a «шаг вместо содержимого» — теряется контекст ввода;
  - 1c «вторая страница с “← Назад”» — лишний выход, шаг читается как навигация, а не
    остановка.
- **Решено:** на время шага список и «Дополнительно» скрыты — модалка без прокрутки (замечание
  автора к 1b).
- **Решено:** тексты шага и «ЗАМЕНИТ сканер {{name}}» — по правке автора. Причину шаг не
  называет; отпечаток, сертификат и идентификатор не показываются (ADR 0003).
- **Решено:** адрес в карточке показывается всегда — и при ручном вводе (открытый вопрос
  брифа). Он стоит рядом с именем и сверяется с коробкой одним взглядом.
- **Решено:** предупреждение о документе с двух устройств — только строкой в шаге; на `flip`
  после подключения ничего не добавляется (как предполагает план).
- **Решено:** тост успеха — обычный «Сканер подключён: …».
- **Открыто:** «настройки не записались» по брифу возвращает к вводу, хотя сканер уже
  подключён. Возможно, честнее закрыть модалку и показать тост с тем же текстом — решить при
  реализации с автором.
- **Открыто:** крестика в модалке `device` в референсе нет. Бриф упоминает «Esc и крестик»;
  мок закрывается только по Esc. Если крестик есть в коде — поведение то же, что у Esc.
