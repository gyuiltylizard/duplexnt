import { DEFAULT_LOCALE, type Locale } from '@shared';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '@locales/en/common.json';
import ru from '@locales/ru/common.json';

// Локализация интерфейса. Русская локаль — источник правды типов ключей
// (types/i18next-resources.d.ts) и раскладки; английская (B-41) обязана совпадать с ней по
// базовым ключам и подстановкам — это держит тест паритета, типы расхождения не ловят.
// Старт всегда с `DEFAULT_LOCALE`: jsdom-тесты идут на русском, а настоящий язык приложение
// применяет из снимка до первого кадра (`useLanguage`).
export { DEFAULT_LOCALE };
export const DEFAULT_NAMESPACE = 'common';

export const resources = {
  ru: { common: ru },
  en: { common: en },
} as const satisfies Record<Locale, { common: object }>;

export const i18n = i18next.createInstance();

void i18n.use(initReactI18next).init({
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  defaultNS: DEFAULT_NAMESPACE,
  ns: [DEFAULT_NAMESPACE],
  resources,
  // Ресурсы вшиты в бандл, backend'а нет — инициализация синхронная, первый кадр уже со строками.
  initAsync: false,
  // React экранирует сам.
  interpolation: { escapeValue: false },
});
