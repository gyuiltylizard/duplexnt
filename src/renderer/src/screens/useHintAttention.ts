import { useEffect, useRef, useState, type RefObject } from 'react';
import type { HintId } from '@shared';
import { prefersReducedMotion } from '../state/motion';

// Подсказка «обратить внимание» (B-4, handoff «5. Подсказка про Ctrl/Shift»): при первом показе
// на установку — через 580 мс после появления экрана (растворение 180 + 400 мс, чтобы глаз нашёл
// экран) три такта подсветки по `--duration-loop`, затем покой навсегда. Флаг «показана» —
// в настройках, ставится в момент показа, а не по окончании: закрыли окно на середине — больше
// не мигнёт. Гаснет раньше, если человек уже занялся лентой или навёл на подсказку.
// Reduced-motion — ровная подсветка на `--duration-loop-long`, затем гаснет.

/** Задержка до подсветки: растворение экрана и время найти его глазами. */
export const HINT_ATTENTION_DELAY_MS = 580;
/** Ровная подсветка под reduced-motion — `--duration-loop-long`. */
export const HINT_STATIC_MS = 3800;

export type Attention = 'none' | 'blink' | 'static';

/**
 * `eligible` — подсказка на экране и ещё не показывалась. Решение принимается один раз за жизнь
 * компонента: пришедший позже снимок с флагом идущую подсветку не обрывает.
 */
export function useHintAttention(
  noteRef: RefObject<HTMLElement | null>,
  hint: HintId,
  eligible: boolean,
): Attention {
  const [attention, setAttention] = useState<Attention>('none');
  const [active, setActive] = useState(false);
  const triggered = useRef(false);

  useEffect(() => {
    if (!eligible || triggered.current) {
      return;
    }
    triggered.current = true;
    setActive(true);
    window.api.markHintSeen(hint).then(
      (result) => {
        if (!result.ok) {
          console.error('[editor] подсказка не отмечена показанной', result.error);
        }
      },
      (error: unknown) => {
        console.error('[editor] подсказка не отмечена показанной', error);
      },
    );
  }, [eligible, hint]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const note = noteRef.current;
    const reduced = prefersReducedMotion();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const stop = (): void => {
      setAttention('none');
      setActive(false);
    };
    timers.push(
      setTimeout(() => {
        setAttention(reduced ? 'static' : 'blink');
        if (reduced) {
          timers.push(setTimeout(stop, HINT_STATIC_MS));
        }
      }, HINT_ATTENTION_DELAY_MS),
    );
    // Занялся лентой — подсказка своё сделала.
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest('.rail') !== null) {
        stop();
      }
    };
    const onAnimationEnd = (event: AnimationEvent): void => {
      if (event.target === note) {
        stop();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    note?.addEventListener('mouseenter', stop);
    note?.addEventListener('animationend', onAnimationEnd);
    return () => {
      timers.forEach(clearTimeout);
      document.removeEventListener('pointerdown', onPointerDown);
      note?.removeEventListener('mouseenter', stop);
      note?.removeEventListener('animationend', onAnimationEnd);
    };
  }, [active, noteRef]);

  return attention;
}
