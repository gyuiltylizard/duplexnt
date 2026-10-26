import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import {
  animate,
  distanceOf,
  durationOf,
  easingOf,
  fadeOut,
  leaveWithGhost,
  prefersReducedMotion,
} from '../state/motion';

// Тост по рецепту дизайн-системы: одна строка внизу по центру. Тост в приложении один: новый
// гасит предыдущий — за это отвечает владелец состояния (App), меняя `key`, чтобы срок
// отсчитывался заново. Справа может стоять кнопка действия (handoff M3, S18): нажатие выполняет
// действие и убирает тост.
//
// Движение (B-4): тост проявляется с подъёмом; истёкший или закрытый действием — гаснет копией.
// Вытесненный новым снимается сразу, без ухода (правило «новый гасит предыдущий»).

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
  const toastRef = useRef<HTMLDivElement>(null);
  // Уходит сам — по сроку или действию; иначе его вытеснил новый.
  const expired = useRef(false);

  useLayoutEffect(() => {
    const toast = toastRef.current;
    if (toast !== null) {
      const reduced = prefersReducedMotion();
      const rise = String(distanceOf('--distance-rise'));
      animate(
        toast,
        reduced
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [
              { opacity: 0, transform: `translateX(-50%) translateY(${rise}px)` },
              { opacity: 1, transform: 'translateX(-50%)' },
            ],
        {
          duration: durationOf(reduced ? '--duration-exit' : '--duration-screen'),
          easing: easingOf(reduced ? '--ease-standard' : '--ease-out'),
        },
      );
    }
    return () => {
      if (expired.current) {
        leaveWithGhost(toast, fadeOut);
      }
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      expired.current = true;
      onExpire();
    }, durationMs ?? TOAST_DURATION_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [durationMs, onExpire]);

  return (
    <div className="toast" role="status" ref={toastRef}>
      <span className="toast__text">{text}</span>
      {action !== undefined && (
        <button
          type="button"
          className="toast__action"
          onClick={() => {
            expired.current = true;
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
