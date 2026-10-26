---
title: 'feat: референс текущего интерфейса для Claude Design (B-6)'
type: feat
date: 2026-10-26
status: в работе # в работе → done; заморожен — готов, не начат
---

# feat: референс текущего интерфейса для Claude Design (B-6)

## Summary

Команда `npm run design:snapshot` рендерит настоящие экраны и модалки приложения — боевые
React-компоненты и стили, на фикстурных данных — в `docs/design/reference/`: одна страница с
вкладками по сценам, стили приложения одним файлом, шрифты, картинки страниц. README в
`docs/design/` — контракт для дизайн-агента (Claude Design): мок строится от копии референса,
результат — handoff. Исходный мок M0 уходит в архив. Образец — Shelfory
(`test/design-snapshot/as-built.test.tsx`, `docs/prototype/mock/README.md`).

## Problem Frame

До MVP дизайн брался из мока Claude Design (`docs/design/mock/Сканер ADF.dc.html`), а дырки
закрывал handoff'ами агент-разработчик. Мок застыл на M0: наборы, пары, пустые обороты, плашки,
«+ Добавить», модалки M3.5–M4.5 и правки B-3 есть только в коде и в handoff'ах
`docs/design/handoffs/`. Полировка (B-4, B-5) идёт через Claude Design; от старого мока он
дорабатывал бы дизайн, которого уже нет. Playbook этот процесс уже предусматривает
(`docs/design/README.md`: «референс → бриф → мок → handoff»), команда `<design:snapshot>` стоит
заглушкой.

Решение автора 2026-10-26: делаем по образцу Shelfory, первым в кластере «Полировка UI»;
материалы — папкой (самодостаточной), подключение репозитория — по желанию.

---

## Requirements

**Референс**

- R1. `npm run design:snapshot` пишет `docs/design/reference/index.html` — сцены приложения
  вкладками, отрендеренные из боевых компонентов в jsdom на фикстурах; разметка — та, что в
  приложении (классы, атрибуты, тексты на русском).
- R2. Рядом — `reference/app.css` (все стили renderer'а одним файлом, токены первыми),
  `reference/fonts/` (Golos Text и IBM Plex Mono 400/500/600, кириллица и латиница, с
  `fonts.css`) и `reference/pages/` (картинки страниц из фикстур устройства). Страница
  открывается из файловой системы без сети.
- R3. Сцены покрывают экраны и модалки, которые затрагивают B-4 и B-5, и дают общий контекст:
  `setup`, `scan` (лица и обороты), `flip`, `merge`, `editor` (собранный документ с границей
  документов и скрытым пустым), `editor` в режиме раздельных наборов с модалкой `mismatch`,
  модалки `save`, `add`, `newscan`, `device`.
- R4. Миниатюры и превью — загруженные картинки, а не скелетоны; анимации CSS (подача,
  разворот) живые.
- R5. Перегенерация детерминирована: повторный запуск без изменений UI не меняет файлы.
- R6. Снимок не входит в `npm test` / `test:all` и ничего не пишет вне `docs/design/`.

**Контракт и материалы**

- R7. `docs/design/README.md` — контракт для дизайн-агента: что в папке, правила мока (копия
  референса в `mock/`, свои правки — только в `mock.css` / `mock.js`, без фреймворка и сборки,
  панель сценариев, дизайн в контексте), handoff по шаблону, что нельзя (менять `src/`,
  править сгенерированное, возвращать идеи из архива).
- R8. Шаблон handoff'а — в папке (`docs/design/handoff-template.md`, генерируется из
  `docs/templates/handoff.md`), чтобы папка была самодостаточной.
- R9. Исходный мок M0 — в `docs/design/archive/`, ссылки в доках поправлены.

---

## Key Technical Decisions

- **KTD-1. Отдельный vitest-проект `design` (jsdom), файл `test/design-snapshot/reference.test.tsx`.**
  Как в Shelfory. Под `src/renderer` снимок жить не может: слой renderer запрещает `node:fs`
  и в тестах (lint). В `test/` слоёв нет; свой `tsconfig.design.json` (DOM + JSX + типы Node)
  — `tsconfig.test.json` этот каталог исключает. _Отклонено:_ `toMatchFileSnapshot` из
  renderer-теста плюс скрипт сборки — два места вместо одного ради обхода lint.
- **KTD-2. Сцены — через `<App />` с заглушкой моста** (`stubApi` из `app-fixture.ts`), модалки
  — кликом по настоящим кнопкам; `merge` — компонентом `MergeScreen` напрямую (это пауза между
  снимками, в `App` её держит таймер). Так в референсе ровно та композиция, что в приложении.
- **KTD-3. Картинки:** `src` вида `duplexnt-page://…` заменяется на `pages/page-NN.jpg` по
  номеру страницы, пустой оборот — уменьшенный скан `blank-gray-300` из фикстур; у `<img>`
  вызывается `load`, чтобы автомат `useImageLoad` перешёл из скелетона в «загружено».
- **KTD-4. Шрифты — файлами `@fontsource`** (woff2, подмножества cyrillic и latin), а не Google
  Fonts: референс открывается без сети и ровно теми начертаниями, что в приложении.
- **KTD-5. Кадр 1280×800** — размер, под который рисовался исходный мок; окно приложения по
  умолчанию 1100×760 растягивается.

## High-Level Technical Design

- `test/design-snapshot/reference.test.tsx` — сцены как `it`-блоки: собрать снимок, отрендерить,
  довести до состояния (клики, `load` картинок), снять `#root` + порталы модалок. В `afterAll` —
  сборка `index.html` (вкладки, кадр), конкатенация CSS, копирование шрифтов и картинок.
- `tooling/test-projects.ts` — проект `design`; `package.json` — `design:snapshot`;
  `tsconfig.design.json` + ссылки в `tsconfig.json` и в `eslint.config.ts`.
- `docs/design/` — README (контракт), `reference/` (генерируется), `archive/` (мок M0),
  `briefs/`, `handoffs/`, `handoff-template.md` (генерируется).

## Implementation Units

### U1. Проект `design` и снимок сцен

- **Что:** R1–R6 — проект vitest, tsconfig, команда, файл снимка со сценами, сборка
  `reference/`.
- **Файлы:** `test/design-snapshot/reference.test.tsx`, `tooling/test-projects.ts`,
  `tsconfig.design.json`, `tsconfig.json`, `tsconfig.test.json`, `eslint.config.ts`,
  `package.json`, `docs/design/reference/**` (генерируется).
- **Тесты:** страж проектов (`test/guards/test-projects.test.ts`) видит новый проект; сам снимок
  проверяет, что каждая сцена дошла до своего состояния (заголовок, модалка, картинки
  загружены) — иначе падает, а не пишет пустую сцену.
- **Гейт:** typecheck + lint + test зелёные, `design:snapshot` зелёный и повторно — без diff;
  коммит `feat(b-6): U1 …`.

### U2. Контракт для дизайн-агента и архив

- **Что:** R7–R9 — README, шаблон handoff'а в папке, мок M0 в `archive/`, ссылки.
- **Файлы:** `docs/design/README.md`, `docs/design/archive/**`, спека («Дизайн-система и UI»),
  `docs/docmap.md`, ссылки на `design/mock/` в доках.
- **Гейт:** format:check зелёный; коммит `docs(b-6): U2 …`.

### U3. Проверка, журнал, приёмка

- **Что:** глазами — референс в браузере (скриншоты сцен); журнал
  `docs/solutions/0011-b-6-design-reference.md`; бэклог; `test:all`; приёмка автора.
- **Гейт:** `test:all` зелёный; коммит `docs(b-6): U3 …`; merge — после явного ОК автора.

## Scope Boundaries

- Брифы B-4 и B-5 — отдельно, после B-6.
- Интерактивности в референсе нет — это статичный рендер; поведение делает дизайн-агент в моке.
- Английская локаль — нет (в MVP одна локаль).

## System-Wide Impact

- Новый проект vitest и tsconfig; `test:all` их не запускает.
- Каталог `docs/design/` меняет раскладку: `mock/` теперь — мок дизайн-агента, исходный мок —
  в `archive/`.

## Risks & Dependencies

- jsdom не считает раскладку: всё, что компоненты меряют (`getBoundingClientRect`, прокрутка
  ленты), в референсе — значения по умолчанию. Риск — сцена с позиционированием по замеру;
  смотрим глазами в U3.
- Порталы модалок: снимать `document.body`, а не только `#root`.
- Страж приватности видит сгенерированный HTML — данные только фикстурные.

## Acceptance Examples

- AE1. `npm run design:snapshot` → `docs/design/reference/index.html` открывается в браузере из
  папки: вкладки сцен, экраны как в приложении, шрифты, миниатюры.
- AE2. Повторный запуск без изменений — `git status` чистый.
- AE3. README читается как самодостаточный бриф-контракт: папку можно отдать Claude Design без
  пояснений в чате.

## Documentation / Operational Notes

- Спека: «Дизайн-система и UI» — источник дизайна теперь референс, мок M0 — архив; «Команды» —
  `design:snapshot`.
- `docs/design/README.md` — процесс и контракт; правило «перегенерировать после каждой вехи,
  меняющей UI».
- Бэклог: B-6 → «Завершённое».

## Sources / Research

- Shelfory: `test/design-snapshot/as-built.test.tsx`, `docs/prototype/mock/README.md`,
  `docs/shelfory-project.md` («Процесс дизайна нового UI»).
- Playbook-шаблон: `docs/design/README.md`.
