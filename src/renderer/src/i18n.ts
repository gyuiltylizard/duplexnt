import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import ru from '@locales/ru/common.json';

// Локализация интерфейса. Русская локаль — источник правды типов ключей
// (types/i18next-resources.d.ts). Вторая локаль добавляется файлом в locales/<язык>/ и строкой
// в `resources` — без перестройки кода. Переключателя языка в M0 нет.
export const DEFAULT_LOCALE = 'ru';
export const DEFAULT_NAMESPACE = 'common';

export const resources = {
  ru: { common: ru },
} as const;

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
