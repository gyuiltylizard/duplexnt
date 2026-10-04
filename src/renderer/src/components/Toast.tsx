import { useEffect, type ReactNode } from 'react';

// Тост по рецепту дизайн-системы: одна строка внизу по центру, без анимации появления. Тост в
// приложении один: новый гасит предыдущий — за это отвечает владелец состояния (App), меняя
// `key`, чтобы срок отсчитывался заново.

const TOAST_DURATION_MS = 2600;

export interface ToastProps {
  readonly text: string;
  /** Срок вышел: владелец убирает тост из состояния. */
  readonly onExpire: () => void;
}

export function Toast({ text, onExpire }: ToastProps): ReactNode {
  useEffect(() => {
    const timer = setTimeout(onExpire, TOAST_DURATION_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [onExpire]);

  return (
    <div className="toast" role="status">
      {text}
    </div>
  );
}
