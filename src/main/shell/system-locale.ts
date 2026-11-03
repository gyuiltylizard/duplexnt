import en from '@locales/en/common.json';
import ru from '@locales/ru/common.json';
import { localeOfSystemTag, type Locale } from '@shared';

// Язык в main (B-41, U3; план KTD-5). i18next здесь не нужен: main показывает одни строки до
// старта службы — «хранилище не читается», — и они берутся по системной локали (настройки
// ещё не прочитаны). Правило на будущее: диалог после старта берёт язык из
// `service.snapshot().language`. Electron не импортируется: `app` описан структурно.

interface LocaleApp {
  /** BCP 47 метка системы; доступна после `ready`, до — пустая строка. */
  getLocale(): string;
}

/** Системный язык по правилу B-41: `ru*` → русский, иначе английский. Звать после `ready`. */
export function systemLocaleOf(app: LocaleApp): Locale {
  return localeOfSystemTag(app.getLocale());
}

const BUNDLES = { ru, en } as const;

/** Строки диалога запуска на нужном языке — заголовок и текст «хранилище не читается». */
export function startupStringsOf(locale: Locale): {
  readonly title: string;
  readonly text: string;
} {
  const { startup } = BUNDLES[locale];
  return { title: startup.storageUnreadableTitle, text: startup.storageUnreadable };
}
