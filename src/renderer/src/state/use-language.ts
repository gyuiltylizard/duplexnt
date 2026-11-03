import type { Locale } from '@shared';
import { useLayoutEffect } from 'react';
import { i18n } from '../i18n';

// Язык интерфейса из снимка (B-41, U3; план KTD-4). i18n стартует с русского; настоящий язык
// приходит со снимком, которого `App` и так ждёт, поэтому применение в `useLayoutEffect` —
// до первого кадра, без мигания русским. Ресурсы вшиты: `changeLanguage` меняет язык сразу,
// подписчики `useTranslation` перерисовываются синхронно. `useEffect` отработал бы после
// кадра, а вызов в теле рендера — обновление чужих компонентов во время рендера.

interface LanguageTarget {
  readonly language: string;
  changeLanguage(locale: Locale): unknown;
}

/** Применить язык к i18n и `<html lang>`; повторное применение того же языка — без работы. */
export function applyLanguage(
  locale: Locale,
  target: LanguageTarget = i18n,
  root: { lang: string } = document.documentElement,
): void {
  if (target.language !== locale) {
    void target.changeLanguage(locale);
  }
  if (root.lang !== locale) {
    root.lang = locale;
  }
}

/** Язык из снимка — до первого кадра и при каждом изменении; `null` — снимка ещё нет. */
export function useLanguage(language: Locale | null): void {
  useLayoutEffect(() => {
    if (language !== null) {
      applyLanguage(language);
    }
  }, [language]);
}
