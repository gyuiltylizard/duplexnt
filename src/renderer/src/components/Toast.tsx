import { useEffect, type ReactNode } from 'react';

// Тост по рецепту дизайн-системы: одна строка внизу по центру, без анимации появления. Тост в
// приложении один: новый гасит предыдущий — за это отвечает владелец состояния (App), меняя
// `key`, чтобы срок отсчитывался заново. Справа может стоять кнопка действия (handoff M3, S18):
// нажатие выполняет действие и убирает тост.

const TOAST_DURATION_MS = 2600;

export interface ToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface ToastProps {
  readonly text: string;
  /** Срок показа; по умолчанию 2,6 с, тосты сохранения живут 6 с (UI_SPEC раздел 8). */
  readonly durationMs?: number | undefined;
  readonly action?: ToastAction | undefined;
  /** Срок вышел или нажато действие: владелец убирает тост из состояния. */
  readonly onExpire: () => void;
}

export function Toast({ text, durationMs, action, onExpire }: ToastProps): ReactNode {
  useEffect(() => {
    const timer = setTimeout(onExpire, durationMs ?? TOAST_DURATION_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [durationMs, onExpire]);

  return (
    <div className="toast" role="status">
      <span className="toast__text">{text}</span>
      {action !== undefined && (
        <button
          type="button"
          className="toast__action"
          onClick={() => {
            onExpire();
            action.onClick();
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
