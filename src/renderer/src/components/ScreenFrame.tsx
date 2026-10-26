import { useLayoutEffect, useRef, type ReactNode } from 'react';
import {
  animate,
  durationOf,
  easingOf,
  leaveWithGhost,
  prefersReducedMotion,
} from '../state/motion';

// Смена экранов — растворение (B-4, handoff «1. Смена экранов», вариант 1a). Каждый экран живёт
// в своей рамке с ключом по экрану. Уходя, рамка оставляет в `.app` статичную копию экрана —
// под новым, `inert`; новый поверх проявляется за `--duration-screen`, затем копия снимается.
// Направления нет. Новая смена во время перехода доводит текущую мгновенно: двух уходящих
// экранов не бывает. Модалка, открытая поверх экрана, — его потомок и уходит вместе с ним.

/** Идущий переход: проявление нового экрана и отмена его копии-подложки. */
let current: { fadeIn: Animation | null; dropGhost: () => void } | null = null;
/** В этом коммите экран ушёл — следующий смонтированный проявляется. */
let leftThisCommit = false;

function finishCurrent(): void {
  current?.fadeIn?.finish();
  current?.dropGhost();
  current = null;
}

export function ScreenFrame({ children }: { readonly children: ReactNode }): ReactNode {
  const frameRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const screen = frame?.firstElementChild;
    if (leftThisCommit && screen instanceof HTMLElement) {
      leftThisCommit = false;
      const fadeIn = animate(screen, [{ opacity: 0 }, { opacity: 1 }], {
        duration: durationOf(prefersReducedMotion() ? '--duration-exit' : '--duration-screen'),
        easing: easingOf('--ease-standard'),
      });
      if (current !== null) {
        current.fadeIn = fadeIn;
      }
    }
    return () => {
      const leaving = frame?.firstElementChild;
      const app = frame?.parentElement ?? null;
      finishCurrent();
      leftThisCommit = true;
      // Копия живёт, пока проявляется новый: «держится» на месте без изменений.
      const hold = (ghost: HTMLElement): Animation | null => {
        ghost.classList.add('app__leaving');
        return animate(ghost, [{}, {}], {
          duration: durationOf(prefersReducedMotion() ? '--duration-exit' : '--duration-screen'),
        });
      };
      const dropGhost = leaveWithGhost(leaving instanceof HTMLElement ? leaving : null, hold, {
        parent: app,
        next: app?.firstChild ?? null,
      });
      current = { fadeIn: null, dropGhost };
      queueMicrotask(() => {
        leftThisCommit = false;
      });
    };
  }, []);

  return (
    <div className="app__screen" ref={frameRef}>
      {children}
    </div>
  );
}
