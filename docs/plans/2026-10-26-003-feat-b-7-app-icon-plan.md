---
title: 'feat: значок приложения и установщика (B-7)'
type: feat
date: 2026-10-26
status: в работе # в работе → done; заморожен — готов, не начат
origin: docs/design/handoffs/app-icon.md
---

# feat: значок приложения и установщика (B-7)

## Summary

Значок «Монограмма D’» по handoff'у автора: два SVG-мастера → `build/icon.ico` (9 размеров
16–256) скриптом `npm run icons` → `electron-builder` (`win.icon`: exe, ярлыки, «Пуск»,
установщик, деинсталлятор) и `BrowserWindow.icon` (заголовок, панель задач, Alt+Tab — и в
`dev`). Образец проводки — Shelfory B-50.

## Problem Frame

`electron-builder` ставит значок Electron по умолчанию: `win.icon` не задан, каталога `build/`
нет. Handoff даёт финальные мастера и справочный генератор (`sharp` + `png-to-ico`), выходные
файлы — сгенерировать инструментом проекта.

---

## Requirements

- R1. Мастера из handoff'а лежат в репозитории без изменений геометрии; правило handoff'а: ≤ 24
  px — только из `icon-small.svg`, ≥ 32 px — из `icon.svg`.
- R2. `build/icon.ico` — 16, 20, 24, 32, 40, 48, 64, 96, 256; 32-битный RGBA с альфой; 256 —
  PNG внутри ICO.
- R3. `win.icon` — `build/icon.ico`; установщик и деинсталлятор — тот же значок.
- R4. Окно приложения — тот же `.ico` (в `dev` значок не Electron'а).
- R5. Перегенерация детерминирована: `npm run icons` без изменения мастеров не меняет `.ico`.

## Key Technical Decisions

- **KTD-1. Растры — `sharp` (уже в зависимостях), каждый размер вектором сразу в целевой.**
  Справочный генератор handoff'а для 20 и 24 px растрирует `icon-small.svg` в 16 px и
  растягивает — мыло; плотность считается от целевого размера и ширины мастера.
- **KTD-2. Свой кодировщик ICO (`scripts/ico.ts`) вместо `png-to-ico`.** Формат — заголовок и
  таблица записей; кадры < 256 — классический DIB (BGRA снизу вверх + нулевая AND-маска),
  256 — PNG, как велит handoff. DIB-кадры читают все потребители, включая NSIS и
  редактор ресурсов exe; новая зависимость ради ~60 строк не нужна. Под тестом.
- **KTD-3. `.ico` коммитится** (`build/icon.ico`): сборка не зависит от генерации; мастера —
  рядом (`build/icon.svg`, `build/icon-small.svg`). `build/` — `buildResources`
  electron-builder'а, в пакет приложения не едет.
- **KTD-4. Окно — `import appIcon from '../../build/icon.ico?asset'`** (electron-vite копирует
  ассет в `out/main`, `out/**` — в белом списке пакета), как в Shelfory: Windows берёт размер
  под поверхность — заголовку 16/24 из упрощённого мастера.
- **KTD-5. MSIX-ассеты handoff'а не генерируются** — приложение ставится NSIS.

## Implementation Units

### U1. Генерация и проводка

- **Файлы:** `build/icon.svg`, `build/icon-small.svg`, `build/icon.ico`, `scripts/ico.ts`,
  `scripts/build-icons.ts`, `test/tooling/ico.test.ts`, `package.json` (`icons`),
  `electron-builder.yml`, `src/main/index.ts`, `types/` (типы `?asset`),
  `docs/design/handoffs/app-icon.md` (+ превью).
- **Тесты:** ICO — заголовок, таблица, смещения; DIB — размеры, порядок BGRA снизу вверх,
  маска; PNG-кадр 256 с сигнатурой; файл `build/icon.ico` — 9 кадров нужных размеров.
- **Гейт:** typecheck + lint + test; `npm run icons` повторно — без diff; коммит
  `feat(b-7): U1 …`.

### U2. Сборка, проверка, доки

- `npm run dist` — значок у exe и установщика; запуск — окно и панель задач; журнал
  `docs/solutions/0012-b-7-app-icon.md`; спека («Команды»); приёмка автора.

## Scope Boundaries

- MSIX / WinUI-ассеты — нет (KTD-5). Значок для macOS / Linux — нет (только Windows).
- Подпись кода, версия, прочее из «гейта релиза» — нет.

## Acceptance Examples

- AE1. Установщик и установленный exe — значок D’, не Electron.
- AE2. Окно: заголовок, панель задач (светлая и тёмная тема), Alt+Tab — D’.
- AE3. «Пуск» и ярлык на рабочем столе — D’; Explorer «Огромные значки» — чётко.

## Documentation / Operational Notes

- Спека, «Команды» — `npm run icons`. Handoff — в `docs/design/handoffs/`.
- Кэш значков Windows сбрасывается `ie4uinit.exe -show`, иначе виден старый.
