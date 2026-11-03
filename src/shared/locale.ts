// Язык интерфейса (B-41). Словарь — как `BLANK_MODES` / `STRAIGHTEN_MODES`: одно место для
// схемы ядра, типа снимка и ресурсов i18n. В настройках хранится явный выбор или `null` —
// «следовать системе»; эффективный язык считает ядро из явного выбора и системного по умолчанию,
// который main определяет сам (ядро Electron не импортирует).

export const LOCALES = ['ru', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

/** Язык, с которого стартует i18n и на котором идут jsdom-тесты; системный, если main не сказал. */
export const DEFAULT_LOCALE: Locale = 'ru';

/** Явный выбор пользователя побеждает системный язык; `null` — следовать системе. */
export function resolveLocale(stored: Locale | null, systemDefault: Locale): Locale {
  return stored ?? systemDefault;
}

/**
 * Язык по системной метке (`app.getLocale()` — BCP 47, например `ru-RU`, `en-US`): русская
 * семья → русский, всё остальное, включая пустую метку, → английский (решение автора 2026-11-03).
 */
export function localeOfSystemTag(tag: string): Locale {
  return /^ru(?:[-_]|$)/iu.test(tag.trim()) ? 'ru' : 'en';
}
