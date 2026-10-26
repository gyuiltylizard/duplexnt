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
//
// Был ли уход настоящим, видно только после коммита: StrictMode (dev) тут же «снимает» и снова
// монтирует новый экран, а рамка при этом остаётся в DOM. Поэтому переход утверждается
// микрозадачей — по тому, снята ли рамка, — а до тех пор ничего прежнего не трогает.

interface Transition {
  fadeIn: Animation | null;
  readonly dropGhost: () => void;
}

/** Утверждённый переход: его доводит следующая смена. */
let current: Transition | null = null;
/** Уходы этого коммита: проявление нового экрана записывается в каждый. */
let leavingThisCommit: Transition[] = [];

function screenDuration(): number {
  return durationOf(prefersReducedMotion() ? '--duration-exit' : '--duration-screen');
}

export function ScreenFrame({ children }: { readonly children: ReactNode }): ReactNode {
  const frameRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const screen = frame?.firstElementChild;
    if (leavingThisCommit.length > 0 && screen instanceof HTMLElement) {
      const fadeIn = animate(screen, [{ opacity: 0 }, { opacity: 1 }], {
        duration: screenDuration(),
        easing: easingOf('--ease-standard'),
      });
      for (const transition of leavingThisCommit) {
        transition.fadeIn = fadeIn;
      }
    }
    return () => {
      const leaving = frame?.firstElementChild;
      const app = frame?.parentElement ?? null;
      // Копия живёт, пока проявляется новый: «держится» на месте без изменений.
      const hold = (ghost: HTMLElement): Animation | null => {
        ghost.classList.add('app__leaving');
        return animate(ghost, [{}, {}], { duration: screenDuration() });
      };
      const transition: Transition = {
        fadeIn: null,
        dropGhost: leaveWithGhost(leaving instanceof HTMLElement ? leaving : null, hold, {
          parent: app,
          next: app?.firstChild ?? null,
        }),
      };
      leavingThisCommit.push(transition);
      queueMicrotask(() => {
        leavingThisCommit = [];
        if (frame?.isConnected === true) {
          return; // не уход — повторный монтаж StrictMode
        }
        // Новая смена во время перехода: прежний доводится мгновенно, его копия снимается.
        current?.fadeIn?.finish();
        current?.dropGhost();
        current = transition;
      });
    };
  }, []);

  return (
    <div className="app__screen" ref={frameRef}>
      {children}
    </div>
  );
}
