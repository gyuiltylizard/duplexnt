import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { PageAngle } from '@shared';
import { animate, durationOf, easingOf, prefersReducedMotion } from '../state/motion';
import { freshTurn } from '../state/turns';

// Поворот листа целиком (B-4, handoff «3. Поворот», вариант 2a): конечный вид — классами угла,
// как раньше; поверх — анимация на дельту команды за `--duration-turn` `--ease-out`. Прерванный
// поворот продолжается с текущего положения: быстрые ↻↻↻↻ — одно непрерывное вращение.
// CSS-переходов на `transform` нет намеренно: по модулю 360 они крутили бы 270° → 0° назад.

/** Масштаб миниатюры под углом: альбомная страница вписана в портретную рамку (как в CSS). */
const thumbScale = (angle: number): number =>
  ((angle % 360) + 360) % 180 === 90 ? Math.SQRT1_2 : 1;

interface Running {
  readonly animation: Animation;
  /** Смещение поворота в начале анимации, градусы: к концу оно уходит в 0. */
  readonly offset: number;
}

/**
 * `kind` — что поворачивается: `thumb` — изображение миниатюры в портретной рамке (поворот и
 * масштаб вписывания), `preview` — лист превью целиком (поворот и доведение длинной стороны).
 */
export function useTurnMotion(
  ref: RefObject<HTMLElement | null>,
  key: string,
  angle: PageAngle,
  kind: 'thumb' | 'preview',
): void {
  const previousAngle = useRef<PageAngle | null>(null);
  const previousLong = useRef<number | null>(null);
  const handled = useRef(0);
  const running = useRef<Running | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    const before = previousAngle.current;
    const beforeLong = previousLong.current;
    previousAngle.current = angle;
    if (element === null) {
      return;
    }
    // Длинная сторона нужна только листу превью: миниатюр в ленте много, замер — раскладка.
    const long = kind === 'preview' ? Math.max(element.offsetWidth, element.offsetHeight) : 0;
    previousLong.current = long;
    if (before === null || before === angle) {
      return;
    }
    const turn = freshTurn(key, handled.current);
    if (turn === null || prefersReducedMotion()) {
      return;
    }
    handled.current = turn.seq;
    // Остаток прерванного поворота: смещение, которое он ещё не прошёл.
    const current = running.current;
    let remainder = 0;
    if (current !== null && current.animation.playState === 'running') {
      const progress = current.animation.effect?.getComputedTiming().progress ?? 1;
      remainder = current.offset * (1 - progress);
      current.animation.cancel();
    }
    const offset = remainder - turn.delta;
    const keyframes =
      kind === 'thumb'
        ? [
            {
              transform: `rotate(${String(angle + offset)}deg) scale(${String(thumbScale(angle - turn.delta))})`,
            },
            { transform: `rotate(${String(angle)}deg) scale(${String(thumbScale(angle))})` },
          ]
        : [
            {
              transform: `rotate(${String(offset)}deg) scale(${String(beforeLong !== null && long > 0 ? beforeLong / long : 1)})`,
            },
            { transform: 'none' },
          ];
    const animation = animate(element, keyframes, {
      duration: durationOf('--duration-turn'),
      easing: easingOf('--ease-out'),
    });
    running.current = animation === null ? null : { animation, offset };
  }, [ref, key, angle, kind]);
}
