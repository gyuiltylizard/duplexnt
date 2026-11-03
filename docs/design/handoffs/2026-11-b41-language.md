# Handoff — переключатель языка интерфейса (B-41)

Ручной выбор языка интерфейса на экране `setup`: «Русский» и «English» в нижнем углу правой
колонки «Как это работает». Закрывает бриф `briefs/language.md` (пункты 1–3, ревью копии —
пункт 4, секция «English copy review» ниже). Компонент живёт только на `setup`. Утверждён в
моке 2026-11-03 (вариант 1c, `mock/language-variants.html` → `mock/language.html`).

## Placement

- `setup-screen__aside` («Как это работает») получает `position: relative`; переключатель
  `.lang-switch` прижат к низу колонки абсолютно, под волосяной чертой. Кикер и шаги `howto`
  остаются отцентрированными по вертикали, как сейчас; на высоте окна 800 px шаги до
  переключателя не доходят (запас ≈ 150 px), минимум окна приложения этот запас сохраняет.
- Группа `.params` и «Сбросить параметры» не меняются. Переключатель стоит в другой колонке,
  поэтому не похож на параметр сканирования, и видно, что сброс его не касается.
- Виден всегда: при любом состоянии строки устройства (готов / проверяем / не отвечает /
  другое устройство / сканер не подключён), в том числе когда ряды параметров недоступны.

## Anatomy

```html
<aside class="setup-screen__aside" aria-label="КАК ЭТО РАБОТАЕТ">
  <div class="kicker">КАК ЭТО РАБОТАЕТ</div>
  <ol class="howto">
    …
  </ol>
  <div class="lang-switch" role="radiogroup" aria-label="Язык">
    <span class="kicker" aria-hidden="true">ЯЗЫК</span>
    <span class="lang-switch__opts">
      <button type="button" role="radio" lang="ru" aria-checked="true" class="lang-switch__opt">
        Русский
      </button>
      <button type="button" role="radio" lang="en" aria-checked="false" class="lang-switch__opt">
        English
      </button>
    </span>
  </div>
</aside>
```

- `aria-label` группы — `setup.language.label` в текущей локали; видимый кикер —
  `setup.language.kicker`, скрыт от скринридера (имя уже есть у группы).
- Подписи опций берутся **не** из локали текущего языка: «Русский» всегда русским, «English»
  всегда английским. Ключи лежат в обеих локалях с одинаковым значением (см. Copy), у каждой
  кнопки — `lang` её языка.
- Пока идёт запись: `aria-busy="true"` на группе и `lang-switch__opt--pending` на нажатой
  опции.

## Tokens

Новых токенов нет.

## CSS

```css
.setup-screen__aside {
  position: relative; /* добавить к существующему правилу */
}

.lang-switch {
  position: absolute;
  left: var(--space-15);
  right: var(--space-15);
  bottom: var(--space-12);
  display: flex;
  align-items: center;
  gap: var(--space-6);
  padding-top: var(--space-6);
  border-top: var(--border-width) solid var(--color-border-subtle);
  transition: opacity var(--duration-fast) var(--ease-standard);
}

.lang-switch .kicker {
  margin-right: auto;
}

.lang-switch__opts {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.lang-switch__opt {
  padding: var(--space-2) var(--space-4);
  border: var(--border-width) solid transparent;
  border-radius: var(--radius-m);
  background: none;
  font: var(--font-weight-regular) var(--font-size-m) / var(--leading-snug) var(--font-family-sans);
  color: var(--color-text-subtle);
  cursor: pointer;
}

.lang-switch__opt:hover {
  color: var(--color-text-primary);
}

.lang-switch__opt[aria-checked='true'] {
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  background: var(--color-bg-surface);
  border-color: var(--color-border-default);
  cursor: default;
}

.lang-switch__opt:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 1px;
}

.lang-switch__opt--pending {
  color: var(--color-text-primary);
  border-color: var(--color-accent);
}

/* Клики игнорируются сразу; приглушение — только если запись затянулась дольше 200 мс. */
.lang-switch[aria-busy='true'] {
  opacity: var(--opacity-disabled);
  transition-delay: 200ms;
}

.lang-switch[aria-busy='true'] .lang-switch__opt {
  cursor: progress;
}

@media (prefers-reduced-motion: reduce) {
  .lang-switch {
    transition: none;
  }
}
```

## States

| Состояние | Когда                          | Что меняется                                                                                                                                                                   |
| --------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| rest      | язык записан                   | текущая опция на бумаге `--color-bg-surface` в рамке `--color-border-default`, medium; другая — текст `--color-text-subtle` без рамки                                          |
| hover     | указатель над нетекущей опцией | текст → `--color-text-primary`; у текущей hover ничего не меняет                                                                                                               |
| focus     | фокус с клавиатуры             | кольцо `--color-border-focus` 2 px, отступ 1 px                                                                                                                                |
| pending   | идёт запись настроек           | группа `aria-busy`; рамка нажатой опции — `--color-accent`; выделение пока на прежнем языке; если запись дольше 200 мс — группа приглушается до `--opacity-disabled` за 150 мс |
| applied   | запись удалась                 | экран перерисовывается на новом языке, выделение на новом значении, фокус на нём                                                                                               |
| failed    | запись отказала                | `aria-busy` снят, pending снят, выделение на прежнем языке; тост `setup.language.saveFailed` на прежнем языке                                                                  |

## Behaviour

- **Указатель:** щелчок по нетекущей опции — смена языка. Щелчок по текущей ничего не делает
  (запись не идёт). Пока идёт запись, щелчки по любой опции игнорируются и не ставятся в
  очередь.
- **Смена:** сначала запись `language` в настройки через общий путь записи, потом смена.
  Подтверждения нет, перезапуска нет. После записи i18n переключается на новый язык, и весь
  экран `setup` перерисовывается на месте: ряды параметров, их значения и строка устройства
  остаются как были. Уже показанные тосты не переводятся. Выбор запоминается, и с этого
  момента язык Windows при старте больше не учитывается.
- **Первый запуск:** без сохранённого выбора язык определяется по языку Windows (`ru*` →
  русский, иначе английский), как сейчас.
- **Отказ записи:** тост по общему пути, на прежнем языке. Выделение и язык не меняются.
- **«Сбросить параметры»:** возвращает «Пустые обороты» и «Выравнивание» к значениям по
  умолчанию, язык не трогает.
- **Клавиатура:** как у `Segments` — каждая опция отдельно в порядке Tab; Enter / Space
  выбирают. После смены языка фокус остаётся на только что выбранной опции (DOM
  перерисовался — фокус вернуть явно). Порядок фокуса: последний элемент `setup` после шагов
  «Как это работает».
- **Гейтинг:** не зависит от сканера и от недоступности рядов параметров. Недоступен только
  на время своей записи (`aria-busy`), без подписи — это доли секунды.
- **Доступность:** имя группы — «Язык» / «Language» из текущей локали. У опций `lang="ru"` /
  `lang="en"`, поэтому «English» читается английским голосом. `role="radiogroup"` +
  `role="radio"` + `aria-checked`, как у `Segments`.
- **Движение:** приглушение 150 мс `--ease-standard` с задержкой 200 мс; без задержки и без
  перехода под `prefers-reduced-motion`. Сама смена языка — без анимации.

## Copy

| Ключ (предложение)          | ru                                             | en                                     |
| --------------------------- | ---------------------------------------------- | -------------------------------------- |
| `setup.language.label`      | Язык                                           | Language                               |
| `setup.language.kicker`     | ЯЗЫК                                           | LANGUAGE                               |
| `setup.language.ru`         | Русский                                        | Русский                                |
| `setup.language.en`         | English                                        | English                                |
| `setup.language.saveFailed` | Не удалось сохранить язык — попробуйте ещё раз | Couldn’t save the language — try again |

`setup.language.ru` и `.en` в обеих локалях одинаковые: так подписи берутся из любого языка.
Если в коде уже есть общий тост отказа записи настроек, используем его вместо
`saveFailed`.

## English copy review

Прошёл все одиннадцать сцен референса `EN`. Ключи взяты из предыдущих handoff'ов; где ключ
неизвестен, помечено «сверить» — нужно найти по русской строке в `locales/ru/common.json`.
Строки, которые здесь не упомянуты, утверждены как есть.

### Термин-карта

Утверждена целиком: sheet, page, front sides, backs, pass, document, set, New scan, Add
sheets, Straighten, Blanks, Backs 180°, Not a blank page, Keep as is, Scan the rest, Assemble
document, Revert, Got it. Два уточнения:

- **«Оригинал» → Keep original** (`inspector.straight.keep` = «Оставить оригинал»). Голое
  «Original» на кнопке читается как подпись, а не действие. Около 85 px, в `min-width: 128px`
  помещается.
- **«Новый скан» / New scan** — оставить, но тогда кикер `setup` нужно поменять (ниже).

### Спорные места

| Ключ                                                                                                                        | Сейчас          | Предложение                                     | Почему                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| `setup.kicker`                                                                                                              | NEW SCAN        | SCAN SETUP                                      | совпадал с кнопкой «New scan»; экран и есть настройка скана                             |
| `thumb.tagAdded`                                                                                                            | A{{set}} (план) | S{{set}}                                        | «A1» рядом с «A4» в строке параметров читается как формат листа                         |
| `thumb.tagAddedLabel`, `thumb.addedLabel`, `thumb.addedFrontLabel`, `thumb.addedBackLabel`, `inspector.what.setAdded*`      | set A{{set}}    | set S{{set}}                                    | тот же тег в тексте, иначе в ленте и в инспекторе получаются два разных имени           |
| `thumb.tagBacks`                                                                                                            | bk              | back                                            | «bk» не расшифровывается; mono 9,5 px — +2 знака (~12 px) в подвале карточки помещаются |
| все `… стр.` (`editor.doc.count`, `editor.pass.meta*`, `save.mode.singleHint`, `newScan.*`, `inspector.check.blankPending`) | page / pages    | утвердить: полные слова через `_one` / `_other` | сокращения нет                                                                          |

### Тон и точность

| Ключ                                       | Сейчас                                                                        | Предложение                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| `setup.params.reset`                       | Reset settings                                                                | Reset scan settings                                      |
| `setup.lead` (сверить)                     | … matches the backs to the fronts itself.                                     | … matches the backs to the fronts on its own.            |
| `setup.straight.onTitle`                   | pages scanned with distortion will be straightened. The mode is remembered: … | skewed pages are straightened. The mode is remembered: … |
| `device.search.found`                      | 2 devices found · search continues                                            | 2 devices found · still searching                        |
| `editor.edits.text`                        | Manual edits made                                                             | Edited by hand                                           |
| `inspector.fact.sheetValue`                | no. 1                                                                         | 1                                                        |
| `save.mode.separateHint`                   | by splits: 2 files                                                            | at splits: 2 files                                       |
| `save.mode.singleHint`                     | all 12 pages in a row                                                         | all 12 pages, in order                                   |
| `save.fact.pages`                          | Pages total                                                                   | Total pages                                              |
| `add.mode.oneSided.hint` (сверить)         | One or more sheets, backs are not scanned                                     | One or more sheets, fronts only                          |
| `newScan.fresh` (сверить)                  | Close the current one and start a new scan                                    | Close this one and start a new scan                      |
| `newScan.saveFirst` (сверить)              | Save the current one first                                                    | Save this one first                                      |
| `mismatch.*.text` (режим наборов, сверить) | … or stuck to its neighbor.                                                   | … or stuck to the next one.                              |

«Reset scan settings» в английском обязательно: «settings» без уточнения читается как «все
настройки», то есть и язык тоже. В русском «параметры» и «настройки» уже различаются, поэтому
русскую строку не меняем.

### Длина в узких местах

Английские строки короче русских, всё помещается без переносов и без новых ширин:
«New scan», «+ Add sheets» (кнопки тулбара по 130 px), «Keep original» / «Straighten» (128 px),
статусы устройства «ready», «not responding», «another device at this address» (mono 11,5 px,
около 210 px в строке шириной 520 px), модалки `device` и `save`, плашка прерванного прохода
(«Scan the rest», «Keep as is»).

### Правки русских строк

Не нужны.

## Decisions and open questions

- **Решено:** переключатель в нижнем углу `aside` с текстовыми опциями (вариант 1c).
  Отклонено: 1a, своя группа под параметрами — визуально равна параметрам и отодвигает кнопку
  запуска; 1b, подвал группы — стоит рядом со «Сбросить параметры» и путается с ним.
- **Решено:** сначала запись, потом смена. Выделение не переезжает раньше времени, поэтому
  при отказе откатывать нечего.
- **Решено:** подсказка под переключателем не нужна: кикер «ЯЗЫК» и два названия языков
  понятны без неё.
- **Решено:** форма новая, не `Segments` — тише сегментов и не похожа на параметр. В
  `DESIGN_SYSTEM.md` нужен рецепт «Текстовый переключатель».
- **Открыто:** текст тоста отказа — придуман в моке, сверить с общим тостом отказа записи
  настроек, если он есть.
- **Открыто:** ключи с пометкой «сверить» назначены по смыслу — нужно сопоставить с
  `locales/*/common.json`.
