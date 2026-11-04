# Handoff — инспектор v2 и тулбар `editor`

Перекомпоновка правой колонки экрана `editor` («Сборка страниц»): ПРОВЕРКА уходит в ДЕТАЛИ,
«Сохранить» — под ДОКУМЕНТЫ В НАБОРЕ, «Есть ручные правки» — в тулбар, внизу инспектора
плашка BETA, высоты секций анимируются. Основа — мок M6 (`mock/straighten.html`,
`handoffs/2026-10-m6-straighten.md`), всё M6 сохраняется. Мок: `mock/ui-improvement/inspector-v2.html`
(+ `inspector-v2.js`, `inspector-v2.css`). Утверждено автором 2026-11-04.

Другие экраны (`setup`, `merge`, модалки) не меняются.

## Что изменилось

| Было                                                                               | Стало                                                                                                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Инспектор: ДЕТАЛИ → ВЫРАВНИВАНИЕ → ДОКУМЕНТЫ В НАБОРЕ → ПРОВЕРКА → плашка правок   | ДЕТАЛИ (с ПРОВЕРКОЙ внутри) → ВЫРАВНИВАНИЕ → ДОКУМЕНТЫ В НАБОРЕ → «Сохранить» → подвал BETA            |
| ПРОВЕРКА — отдельная секция, видна всегда                                          | Подраздел ДЕТАЛЕЙ после `dl.facts`; виден только при раскрытых ДЕТАЛЯХ                                 |
| «Сохранить N файлов» — `btn--primary btn--small` в `.editor-screen__toolbar-right` | `btn--primary` на всю ширину, последним элементом секции ДОКУМЕНТЫ В НАБОРЕ (после `.inspector__note`) |
| `.edits-bar` внизу инспектора, с подложкой и рамкой                                | В `.editor-screen__toolbar-right`, без подложки и рамки: мигающая точка, текст слева, «Вернуть» справа |
| Точка «Есть несохранённые изменения» (`.editor-screen__unsaved`) в тулбаре         | Убрана                                                                                                 |
| Центр тулбара: метка, название, «документ N из M · стр. K из L»                    | Метка и название; `.editor-screen__doc-pos` убран                                                      |
| Секции появляются/исчезают и ДЕТАЛИ раскрываются скачком                           | Анимация высоты (см. Motion)                                                                           |
| —                                                                                  | Подвал инспектора: плашка BETA, прижата вниз и вправо                                                  |

## Placement

- **Тулбар, правая зона** (над инспектором). Пока есть ручные правки — `.edits-bar` на всю
  ширину зоны (паддинги зоны `0 var(--space-8)` прежние). Нет правок — зона пустая.
- **ДЕТАЛИ.** Порядок внутри `.details`: заголовок `.details__title` → `dl.facts` → подраздел
  ПРОВЕРКА. Содержимое ПРОВЕРКИ — прежнее (пункты M3 + пункт выравнивания M6).
- **ДОКУМЕНТЫ В НАБОРЕ.** Список → `.inspector__note` → кнопка «Сохранить…». Текст кнопки
  прежний (`Сохранить документ` / `Сохранить N файлов`), правила недоступности (запись, сборка,
  `blankPending`, `straightenPending`) — прежние.
- **Подвал инспектора.** `margin-top: auto` — внизу колонки, если контента мало; при скролле
  уходит вниз вместе со всем.

## Anatomy

```html
<!-- Тулбар, правая зона -->
<div class="editor-screen__toolbar-right">
  <div class="edits-bar" role="status">
    <span class="dot dot--warning edits-bar__dot" aria-hidden="true"></span>
    <p class="edits-bar__text">Есть ручные правки</p>
    <button type="button" class="btn btn--tinted" title="Вернуть всё как после сканирования">
      Вернуть
    </button>
  </div>
</div>

<!-- ДЕТАЛИ с ПРОВЕРКОЙ -->
<section class="inspector__section inspector__section--details">
  <button type="button" class="details-toggle" aria-expanded="true">…</button>
  <div class="details">
    <h2 class="details__title">Стр. 1 — лицо листа 1</h2>
    <dl class="facts">…</dl>
    <div class="details__checks">
      <h3 class="kicker">ПРОВЕРКА</h3>
      <ul class="checks">
        …
      </ul>
    </div>
  </div>
</section>

<!-- ДОКУМЕНТЫ В НАБОРЕ -->
<section class="inspector__section">
  <div class="inspector__heading">…</div>
  <ul class="doc-list">
    …
  </ul>
  <p class="inspector__note">…</p>
  <button type="button" class="btn btn--primary inspector__save">Сохранить 2 файла</button>
</section>

<!-- Подвал -->
<footer class="inspector__footer">
  <span class="beta-badge">BETA</span>
</footer>
```

В моке классы с префиксом `iv2-`: `iv2-checks` → `details__checks`, `iv2-save` →
`inspector__save`, `iv2-blink` → `edits-bar__dot`, `iv2-foot` → `inspector__footer`,
`iv2-beta` → `beta-badge`. Обёртка `#iv2-edits` — артефакт мока, в продукте не нужна.

## CSS

```css
.inspector {
  display: flex;
  flex-direction: column;
}
.inspector > * {
  flex-shrink: 0;
} /* обязательно: иначе анимация высоты упирается в сжатие */

.details__checks {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-top: var(--space-4);
  border-top: var(--border-width) solid var(--color-border-subtle);
}
.details__checks .kicker {
  margin: 0;
}

.inspector__save {
  width: 100%;
  justify-content: center;
}

.editor-screen__toolbar-right .edits-bar {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 0;
  gap: var(--space-4);
  border: 0;
  background: none;
}
.editor-screen__toolbar-right .edits-bar__text {
  text-align: left;
  white-space: nowrap;
}
.editor-screen__toolbar-right .edits-bar .btn {
  padding-block: var(--space-2);
}
.edits-bar__dot {
  flex: none;
  animation: edits-blink 1.2s ease-in-out infinite;
}
@keyframes edits-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.2;
  }
}

.inspector__footer {
  margin-top: auto;
  display: flex;
  justify-content: flex-end;
  padding: var(--space-8);
}
.beta-badge {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 7px;
  border-radius: 5px;
  font: var(--font-weight-semibold) var(--font-size-xxs) / 1 var(--font-family-mono);
  letter-spacing: var(--tracking-caps);
  background: var(--color-bg-inverse);
  color: var(--color-text-on-inverse);
}

@media (prefers-reduced-motion: reduce) {
  .edits-bar__dot {
    animation: none;
  }
}
```

Удаляются: `.edits-bar` внизу инспектора (его `margin` из app.css перекрыт), кнопка
сохранения в тулбаре, `.editor-screen__unsaved`, `.editor-screen__doc-pos`.

## Motion

Высота секций инспектора — анимация `height` старое → новое, `240ms`,
`cubic-bezier(.4, 0, .2, 1)`, `overflow: hidden` на время анимации. Нижние секции едут сами
по потоку (FLIP не нужен).

- **ДЕТАЛИ, раскрытие:** высота секции от свёрнутой к полной; `.details` проявляется
  `opacity 0 → 1`, задержка ¼ длительности; стрелка `rotate(0 → 180deg)`.
- **ДЕТАЛИ, свёртывание:** `.details` остаётся видимым до конца анимации, гаснет
  `opacity 1 → 0` за 60% длительности, высота от полной к свёрнутой; `hidden` ставится в конце.
  Стрелка `180 → 0deg`.
- **ВЫРАВНИВАНИЕ появляется** (переход на страницу со статусом): высота `0 → h`,
  `opacity 0 → 1`.
- **ВЫРАВНИВАНИЕ меняет текст** (соседняя страница, другой статус): высота `h1 → h2`.
- **ВЫРАВНИВАНИЕ исчезает:** на его месте спейсер высотой `h → 0`, ДОКУМЕНТЫ поднимаются
  плавно.
- **Замер:** высоты брать через `offsetHeight` (layout-размер), не `getBoundingClientRect`, —
  иначе при масштабировании окна (zoom, DPI-скейл) старт анимации неверный и виден рывок.
- **Скролл** инспектора сохраняется.
- **`prefers-reduced-motion`:** анимаций высоты нет, точка не мигает.

## Accessibility

- `.edits-bar` сохраняет `role="status"`; точка `aria-hidden`.
- ПРОВЕРКА внутри ДЕТАЛЕЙ — `h3` под `h2` секции; при свёрнутых ДЕТАЛЯХ скрыта (`hidden`),
  скринридер её не читает — как и остальные факты.
- Порядок Tab в инспекторе: ДЕТАЛИ → ВЫРАВНИВАНИЕ → документы → «Сохранить».
- Плашка BETA — обычный текст, не интерактивна.

## Открыто / допущения

- **Допущение:** ПРОВЕРКА видна только при раскрытых ДЕТАЛЯХ. Если важно видеть
  предупреждения (`pending`, отказы) при свёрнутых — показывать их в `detailsSummary`
  или вынести обратно.
- **Допущение:** без точки несохранённых изменений сигнал «не сохранено» остаётся только в
  модалке `newscan` и заголовке окна (если есть).
- **Известно:** в тулбаре слева «Новое сканирование» не помещается в ширину колонки ленты
  при 1280 px — было и до v2.

## Решения при внедрении (автор, 2026-11-04, разбор с агентом-разработчиком)

Мок строился от референса конца октября и трёх вещей, появившихся позже, не видел.

1. **Ссылка на проект (B-42) остаётся — плашкой «D’ BETA».** Подвал инспектора: одна тёмная
   плашка 22 px по правому краю — монограмма D’ без плитки (из `build/icon-small.svg`) и текст
   BETA; плашка целиком — ссылка на страницу проекта, текстовой ссылки нет (правки автора на
   приёмке 2026-11-04; первые варианты — логотип слева со ссылкой текстом под ним, затем
   логотип-ссылка и отдельная плашка рядом).
2. **«Собрать документ» (режим раздельных наборов, M3.6) — в тот же слот инспектора,** что
   «Сохранить»: последним элементом секции ДОКУМЕНТЫ В НАБОРЕ, на всю ширину, причина
   недоступности в `title` прежняя. Правая зона тулбара во всех режимах держит только плашку
   правок.
3. **ПРОВЕРКА под свёрнутыми ДЕТАЛЯМИ: сигнал наружу.** Пока в ПРОВЕРКЕ есть хоть один пункт с
   точкой, в свёрнутой строке ДЕТАЛЕЙ перед «стр. 7» стоит янтарная точка (`dot dot--warning`,
   `title` «В проверке есть замечания»); при раскрытых — точки нет. Допущение handoff'а снято.
4. **Секция ПУСТОЙ ОБОРОТ (M4)** остаётся между ДЕТАЛЯМИ и ВЫРАВНИВАНИЕМ и появляется /
   исчезает той же анимацией высоты, что ВЫРАВНИВАНИЕ.
5. **Длительность и кривая — токенами** (`--duration-section: 240ms`,
   `--ease-section: cubic-bezier(0.4, 0, 0.2, 1)`), не литералами; мигание точки —
   `--duration-loop` / `--ease-loop`.
6. **Точка «не сохранено» уходит без замены:** в заголовке окна сигнала нет, подтверждения при
   закрытии окна нет и не нужно — сессия лежит на диске и восстанавливается при следующем
   запуске; остаётся модалка `newscan`.
