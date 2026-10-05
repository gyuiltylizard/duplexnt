import { useEffect, type RefObject } from 'react';

/**
 * Фокус на контейнер экрана, когда условие становится истинным: интерактивные элементы
 * пропали (S15 M1, S2 M2) или их на экране нет вовсе (`merge`). Одна a11y-логика на экраны.
 */
export function useFocusWhen(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (active) {
      ref.current?.focus();
    }
  }, [ref, active]);
}
