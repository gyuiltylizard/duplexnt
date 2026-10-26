import { useLayoutEffect, useRef, type RefObject } from 'react';
import {
  animate,
  distanceOf,
  durationOf,
  easingOf,
  leaveWithGhost,
  prefersReducedMotion,
} from '../state/motion';

// Лента последних страниц на `scan` (B-4, handoff «2. Лента»): приход страницы — FLIP. Новая
// карточка въезжает справа, остальные сдвигаются от того места, где их видно сейчас (сдвиг,
// не доигравший до прихода следующей страницы, продолжается с текущего положения — очереди
// нет), выталкиваемая гаснет и уходит влево. Страницы приходят раз в ~300 мс, сдвиг — 180 мс.

/** Текущий сдвиг по X из матрицы трансформации (0 — сдвига нет). */
function translateXOf(element: Element): number {
  const transform = getComputedStyle(element).transform;
  if (transform === '' || transform === 'none') {
    return 0;
  }
  const match = /^matrix\(([^)]+)\)$/.exec(transform);
  const parts = match?.[1]?.split(',').map(Number) ?? [];
  return parts[4] ?? 0;
}

/** Хук ленты: `keys` — ключи страниц в порядке показа. */
export function useStripMotion(stripRef: RefObject<HTMLElement | null>, keys: readonly string[]) {
  const lefts = useRef<Map<string, number> | null>(null);
  const moving = useRef(new Map<string, Animation>());
  const signature = keys.join('|');

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (strip === null) {
      return;
    }
    // Копия выталкиваемой (ещё гаснет при быстром приходе) — не карточка ленты.
    const cards = [
      ...strip.querySelectorAll<HTMLElement>(':scope > [data-key]:not(.strip__card--leaving)'),
    ];
    const before = lefts.current;
    const reduced = prefersReducedMotion();
    const duration = durationOf(reduced ? '--duration-exit' : '--duration-screen');
    const easing = easingOf('--ease-out');
    const enter = distanceOf('--distance-enter');
    const next = new Map<string, number>();
    for (const card of cards) {
      const key = card.dataset.key ?? '';
      // Видимое место — до отмены идущего сдвига: прежняя раскладка плюс текущий сдвиг.
      const previous = before?.get(key);
      const visible = previous === undefined ? undefined : previous + translateXOf(card);
      moving.current.get(key)?.cancel();
      moving.current.delete(key);
      const left = card.offsetLeft;
      next.set(key, left);
      if (before === null) {
        continue; // первый показ — не приход
      }
      let animation: Animation | null = null;
      if (visible === undefined) {
        animation = animate(
          card,
          reduced
            ? [{ opacity: 0 }, {}]
            : [{ opacity: 0, transform: `translateX(${String(enter)}px)` }, { transform: 'none' }],
          { duration, easing },
        );
      } else if (!reduced && Math.abs(visible - left) > 0.5) {
        animation = animate(
          card,
          [{ transform: `translateX(${String(visible - left)}px)` }, { transform: 'none' }],
          { duration, easing },
        );
      }
      if (animation !== null) {
        moving.current.set(key, animation);
      }
    }
    lefts.current = next;
  }, [stripRef, signature]);
}

/**
 * Выталкиваемая карточка (handoff: `strip__card--leaving`): уходя, оставляет копию на своём
 * месте — гаснет с затухания ленты и уходит влево за `--duration-exit`. Под reduced-motion —
 * снимается сразу.
 */
export function useLeavingCard(cardRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const card = cardRef.current;
    return () => {
      if (card === null || prefersReducedMotion()) {
        return;
      }
      const left = card.offsetLeft;
      const top = card.offsetTop;
      const from = getComputedStyle(card).opacity;
      leaveWithGhost(card, (ghost) => {
        ghost.classList.add('strip__card--leaving');
        ghost.style.left = `${String(left)}px`;
        ghost.style.top = `${String(top)}px`;
        return animate(
          ghost,
          [
            { opacity: from, transform: 'none' },
            {
              opacity: 0,
              transform: `translateX(-${String(distanceOf('--distance-enter'))}px)`,
            },
          ],
          { duration: durationOf('--duration-exit'), easing: easingOf('--ease-standard') },
        );
      });
    };
  }, [cardRef]);
}
