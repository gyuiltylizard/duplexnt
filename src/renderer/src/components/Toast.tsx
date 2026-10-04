import { useEffect, type ReactNode } from 'react';

// Тост по рецепту дизайн-системы: одна строка внизу по центру, без анимации появления. Тост в
// приложении один: новый гасит предыдущий — за это отвечает владелец состояния (App), меняя
// `key`, чтобы срок отсчитывался заново.

const TOAST_DURATION_MS = 2600;

export interface ToastProps {
  readonly text: string;
  /** Срок показа; по умолчанию 2,6 с, тосты сохранения живут 6 с (UI_SPEC раздел 8). */
  readonly durationMs?: number | undefined;
  /** Срок вышел: владелец убирает тост из состояния. */
  readonly onExpire: () => void;
}

export function Toast({ text, durationMs, onExpire }: ToastProps): ReactNode {
  useEffect(() => {
    const timer = setTimeout(onExpire, durationMs ?? TOAST_DURATION_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [durationMs, onExpire]);

  return (
    <div className="toast" role="status">
      {text}
    </div>
  );
}
