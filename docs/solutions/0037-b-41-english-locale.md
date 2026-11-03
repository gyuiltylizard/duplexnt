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

| Сессия | Фаза                                                 | Юниты          | Статус                                      |
| ------ | ---------------------------------------------------- | -------------- | ------------------------------------------- |
| —      | планирование                                         | план, ревью    | ✅ 2026-11-03                               |
| 1      | настройка, перевод, язык в renderer и main, референс | U1, U2, U3, U5 | ✅ закрыта 2026-11-03 (`d997533`…`6921529`) |
| —      | бриф, мок и handoff переключателя + ревью копии      | U4             | ⏳ бриф передан автору 2026-11-03           |
| 2      | переключатель, правки копии, документы, смоук        | U6, U7         | ⬜ не начата                                |

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

### U5. Референс дизайна на двух языках — ✅ зелёный

`test/design-snapshot/reference.test.tsx`: каждая сцена — `scene(meta, body, options)`, тело
получает `t` сцены и возвращает контейнер; обёртка прогоняет тело для каждой локали из
`LOCALES`, между прогонами `cleanup()` и `vi.unstubAllGlobals()`, после сцены — язык обратно на
`ru`. Ожидания — по ключам (`t('setup.start')`, `t('editor.saveFiles', { count: 2 })`,
`named(t('editor.newScan'))` для кнопок с глифом); литералов русского текста в запросах не
осталось. Страж — `SCENE_COUNT × LOCALES.length` снимков. `index.html`: вкладки по сценам,
второй ряд `RU | EN`, у кадра `lang` своего языка, адрес `#editor:en`.

**Грабли (U3 ↔ U5):** после U3 `App` сам применяет язык из снимка, и фикстурный снимок с
`language: 'ru'` откатывал английский прогон на русский — десять сцен падали по таймауту.
`renderApp` теперь подставляет язык текущего прогона в снимок (`currentLocale`). Типизированный
`t` с подстановками уткнулся в «type instantiation is excessively deep» — `t` сцены объявлен
простой сигнатурой `(key, options) => string`.

**Отклонение от плана (осознанное):** подписи сцен (`note`, `title`) остались по-русски и не
дублируются — это пометки для дизайн-агента, а не строки интерфейса; второй экземпляр они не
получают. `docs/design/README.md`: интерфейс на двух языках, русский задаёт раскладку, в
handoff'е `## Copy` с колонками `ru | en`.

Снимки headless-Chrome сцен `editor`, `save`, `device` на `EN` и `setup` на `RU`: тексты на
месте, переполнений в тулбаре, кнопке состояния, модалках нет; «6 pages» вместо «6 стр.» в
ленте и сводке укладывается.

**Готово:** typecheck, lint, format:check, `npm run design:snapshot` зелёные (11 сцен, 22
снимка). Коммит `feat(b-41): U5 …`.

### Сессия 1 — итог

Граница сессии достигнута: приложение на `out/` идёт по-английски при `--lang=en-US`,
референс на двух языках, журнал заведён. Гейт: typecheck, lint, format:check, `npm test`
154 / 2710, `test:integration` зелёные на U1. Дальше — бриф U4 автору.

---

## U4. Бриф, мок и handoff: переключатель и ревью английской копии — ⏳ у автора

Бриф `docs/design/briefs/language.md` (2026-11-03): переключатель на `setup` (стадия 1 —
варианты размещения, стадия 2 — в контексте на обоих языках), поведение смены, доступность,
ревью английской копии по всем одиннадцати сценам референса `EN` с термин-картой и спорными
местами из U2. Ожидаемые артефакты: handoff переключателя с `## Copy` в колонках `ru | en` и
список правок «ключ → текст». Без утверждения автора U6 не начинается.

---

## На чём встали

Сессия 1 закрыта (U1, U2, U3, U5). Бриф U4 передан автору — дальше Claude Design: мок,
утверждение, handoff. Сессия 2 (U6 переключатель и правки копии, U7 документы и смоук в en)
начинается после утверждённого handoff'а. До U6 на машине автора приложение по умолчанию
английское (язык интерфейса Windows — en-US); для русского — `--lang=ru-RU` или запись
`"language": "ru"` в файл настроек.

## Закрытие вехи

<заполняется на merge>
