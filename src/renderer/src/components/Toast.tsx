import { useEffect, type ReactNode } from 'react';

// Тост по рецепту дизайн-системы: одна строка внизу по центру, без анимации появления. Тост в
// приложении один: новый гасит предыдущий — за это отвечает владелец состояния (App), меняя
// `key`, чтобы срок отсчитывался заново.

export const TOAST_DURATION_MS = 2600;

export interface ToastProps {
  readonly text: string;
  /** Срок вышел: владелец убирает тост из состояния. */
  readonly onExpire: () => void;
  readonly durationMs?: number;
}

export function Toast({ text, onExpire, durationMs = TOAST_DURATION_MS }: ToastProps): ReactNode {
  useEffect(() => {
    const timer = setTimeout(onExpire, durationMs);
    return () => {
      clearTimeout(timer);
    };
  }, [onExpire, durationMs]);

  return (
    <div className="toast" role="status">
      {text}
    </div>
  );
}
