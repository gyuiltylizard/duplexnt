import 'i18next';
import type common from '../locales/ru/common.json';

// Типы ключей `t()` выводятся из русской локали: опечатка в ключе ломает typecheck.
// Augmentation лежит в types/, а не в src/shared: это не контракт между процессами.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: {
      common: typeof common;
    };
  }
}
