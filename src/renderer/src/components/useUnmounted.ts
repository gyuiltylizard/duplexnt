import { useEffect, useRef, type RefObject } from 'react';

/**
 * Компонент размонтирован — ответ моста, пришедший после закрытия модалки, состояние не трогает.
 * Флаг снимается на каждом монтировании: StrictMode размонтирует и монтирует заново.
 */
export function useUnmounted(): RefObject<boolean> {
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);
  return unmounted;
}
