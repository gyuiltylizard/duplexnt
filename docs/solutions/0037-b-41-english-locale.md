---
title: 'B-41 — Английская локаль интерфейса: журнал реализации'
type: solution
date: 2026-11-03
milestone: B-41
status: в работе
plan: ../plans/2026-11-03-001-feat-b-41-english-locale-plan.md
---

# B-41 — Английская локаль интерфейса (журнал)

Живой журнал реализации [плана](../plans/2026-11-03-001-feat-b-41-english-locale-plan.md). План —
замороженный артефакт решений; этот файл копит **отклонения, грабли и «на чём встали»** по ходу
сессий. Финализируется на закрытии (`status: done`).

ADR вехи: нет — развилки локальны для файла настроек и main (план, «Documentation / Operational
Notes»); решения записываются здесь.

## Карта сессий

| Сессия | Фаза                                                 | Юниты          | Статус        |
| ------ | ---------------------------------------------------- | -------------- | ------------- |
| —      | планирование                                         | план, ревью    | ✅ 2026-11-03 |
| 1      | настройка, перевод, язык в renderer и main, референс | U1, U2, U3, U5 | ⏳ в работе   |
| —      | бриф, мок и handoff переключателя + ревью копии      | U4             | ⬜ не начата  |
| 2      | переключатель, правки копии, документы, смоук        | U6, U7         | ⬜ не начата  |

---

## Сессия 1 — настройка, перевод, язык в renderer и main, референс

### U1. Словарь языков, настройки v6, снимок, команда `setLanguage` — ✅ зелёный

`src/shared/locale.ts`: `LOCALES`, `Locale`, `DEFAULT_LOCALE = 'ru'`, `resolveLocale(stored,
systemDefault)` и `localeOfSystemTag(tag)` (`ru`, `ru-RU`, `ru_RU`, `RU` → `ru`; `uk`, `be`,
пустая метка, `rus` → `en`). Резолв системной метки положен в `shared`, а не в main: чистая
функция без Electron, main в U3 только подставит `app.getLocale()`.

`settings-store.ts`: `settingsV5Schema` заморожена, v6 = v5 + `language: z.enum(LOCALES)
.nullable()`; `parseSettings` поднимает v1–v5 значением `null`, ветка `marker === 5` добавлена
по образцу v4; `settingsOf`, стартовое значение, `setLanguage`, абзац «Версия 6» в шапке.
Тесты: ожидаемые объекты по всему файлу получили `language: null` (perl по строкам
`seenHints`), литералы `version: 5` → 6, «маркер новее» → 7; **грабли:** вставка задела и
входной JSON v4 — неизвестное поле сделало файл «несовместимым», одна строка снята. Два новых
теста: v5 → v6 при `setLanguage('en')`, память и файл при негодном `'de'`.

`pass-service.ts`: `PassServiceOptions.systemLocale?` (без опции — `DEFAULT_LOCALE`, вызовы
в тестах не тронуты), `Snapshot.language = resolveLocale(settings.language, systemLocale)`,
`setLanguage` с `notify()`. Мост по чеклисту ADR 0005: `BridgeCommands.setLanguage`, канал
`duplexnt:set-language`, `localeSchema`, обработчик, `preload/api.ts`; тест обработчика с
мусором `'EN'`, `'en-US'`, `'de'`. Фикстуры снимков (12 файлов) — `language: 'ru'` после
`straightenMode` одним sed; `stubApi` в `app-fixture.ts` и локальный стаб `SetupScreen.test`
— `setLanguage`; моки `SettingsStore` в `scanner-slot.test.ts` — `setLanguage` и `language:
null`. Тест «Сбросить параметры» проверяет, что `setLanguage` не зовётся.

**Готово:** typecheck, lint, format:check, `npm test`, `test:integration` зелёные. Коммит
`feat(b-41): U1 …`.

### U2. Английская локаль и тесты паритета — ✅ зелёный

`locales/en/common.json` — перевод всех ключей по термин-карте плана: sheet / page, front
sides / backs, document, pass, «New scan», «Add sheets», straighten / Original, «Not a blank
page», «Keep as is», «Scan the rest», «Assemble document», «Revert». Плюрали — `_one/_other`.
Там, где русский обходил склонение через «стр.», английский получил формы: `toast.added`,
`toast.straightRestored`, `toast.straightLate`, `toast.straightRecalcCount`,
`editor.doc.count`, `save.fileMeta`, `save.fact.straightValue`,
`inspector.check.straightened` — i18next при `count` берёт `key_one/_other`, русский ключ без
форм не тронут (закреплено тестом).

**На ревью дизайн-агента (U4), решения переводчика:** тег добавленного набора «Д{{set}}» →
«A{{set}}» (added), везде «set A1»; тег оборота «об» → «bk» (две буквы, как в макете); «стр.» →
полные «page / pages» (короче ничего честного нет — длину смотреть в узких местах); «проход» →
«pass»; кикер `setup` «NEW SCAN» совпадает с кнопкой «New scan» (в русском — «НОВОЕ
СКАНИРОВАНИЕ» / «Новый скан»); «Пустые» → «Blanks», «Обороты на 180°» → «Backs 180°».

`i18n.ts`: `resources` с обеими локалями, `satisfies Record<Locale, …>`, `DEFAULT_LOCALE` —
реэкспорт из `shared`; старт по-прежнему `ru`. `i18n.test.tsx`: паритет базовых ключей в обе
стороны (суффиксы плюралей сняты), набор форм (`en` — только `_one/_other`), одинаковые
`{{подстановки}}` у каждой пары строк, непустые строки, английские плюрали через
`getFixedT('en')` (1 / 2 / 0 / 21 / 1.5), «английский суффикс не ломает русский». Запрет
рабочих терминов для en не вводится (план, Deferred).

**Готово:** typecheck, lint, format:check, `npm test` зелёные. Коммит `feat(b-41): U2 …`.

### U3. Язык в renderer и в main — ✅ зелёный

`src/renderer/src/state/use-language.ts`: `applyLanguage(locale, target = i18n, root =
document.documentElement)` — `changeLanguage` только при смене, `lang` только при смене;
`useLanguage(language | null)` в `useLayoutEffect` (план KTD-4: до первого кадра, не в теле
рендера). В `App` — сразу после `useSyncExternalStore` снимка, до раннего возврата. Тест с
настоящим i18n: язык меняется синхронно; `App` с английским снимком показывает «Scanning both
sides in two passes» и `lang="en"`; `afterEach` возвращает русский.

`src/main/shell/system-locale.ts`: `systemLocaleOf(app)` над `localeOfSystemTag` из `shared`,
`startupStringsOf(locale)` выбирает бандл `ru | en` — i18next в main нет. `index.ts`:
`systemLocale` считается в `start()` после `ready`, уходит опцией в `openPassService`, диалог
`storageUnreadable` получает язык параметром; прямой импорт `ru` из `index.ts` снят.

**Живьём на `out/`** (CDP, отдельный `DUPLEXNT_USER_DATA`): `--lang=en-US` → `lang="en"`,
заголовок «Scanning both sides in two passes», кикер «NEW SCAN». **Находка:** без ключа —
тоже английский: на машине автора `app.getLocale()` = `en-US` (язык интерфейса Windows),
`getPreferredSystemLanguages()` = `[en-US, ru]`, `getSystemLocale()` = `ru-RU`. Решение
автора 2026-11-03: правило остаётся «язык интерфейса Windows» (`getLocale`), как в плане;
альтернатива «русский есть в предпочитаемых → русский» отклонена как нестандартная. До U6 у
автора приложение по умолчанию английское; AE2 читать как «на системе с русским языком
интерфейса».

**Готово:** typecheck, lint, format:check, `npm test` 154 / 2710 зелёные. Коммит
`feat(b-41): U3 …`.

### U5. Референс дизайна на двух языках — ⏳ в работе

---

## На чём встали

Сессия 1 начата 2026-11-03: план закоммичен, журнал заведён, U1 в работе.

## Закрытие вехи

<заполняется на merge>
