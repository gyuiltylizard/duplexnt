import { useEffect, type RefObject } from 'react';

// Автопрокрутка ленты при переносе страниц (B-10, план 2026-10-27-004). Нативный перенос в
// Windows не пропускает колесо мыши, а встроенная прокрутка Chromium у края узкая и медленная —
// без своей до места за пределами видимой части ленты не дотянуться. Слушатель `dragover` — на
// `document` в перехвате (KTD-1): миниатюра глушит всплытие, а указатель за краем ленты (над
// тулбаром, подвалом) лента не видит. Живёт, только пока идёт свой перенос: чужое перетаскивание
// (файлы, текст) ленту не двигает. `dragover` лишь обновляет точку, ленту двигает цикл кадров
// (KTD-3); маркер броска за прокруткой ставят прежние обработчики — браузер шлёт `dragover` и при
// неподвижном указателе, уже тому, что под ним. Reduced-motion не влияет: это не украшение.

/** Зона у края ленты, где начинается прокрутка, px. */
export const AUTO_SCROLL_ZONE = 48;
/** Скорость на внутренней границе зоны, px/с. */
export const AUTO_SCROLL_MIN = 120;
/** Скорость у самого края и за ним, px/с. */
export const AUTO_SCROLL_MAX = 900;
/** Сколько ждать следующего `dragover`, прежде чем счесть перенос оборвавшимся, мс. */
export const AUTO_SCROLL_STALE_MS = 400;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * Скорость прокрутки, px/с со знаком: минус — вверх. Ноль — вне зоны края или вбок за лентой.
 * Внутри зоны растёт линейно к краю, за краем (в пределах ширины ленты) — максимальная.
 */
export function autoScrollSpeed(point: Point, box: Box): number {
  if (point.x < box.left || point.x > box.right) {
    return 0;
  }
  const ramp = (depth: number): number =>
    depth >= AUTO_SCROLL_ZONE
      ? AUTO_SCROLL_MAX
      : AUTO_SCROLL_MIN + ((AUTO_SCROLL_MAX - AUTO_SCROLL_MIN) * depth) / AUTO_SCROLL_ZONE;
  const fromTop = point.y - box.top;
  if (fromTop < AUTO_SCROLL_ZONE) {
    return -ramp(AUTO_SCROLL_ZONE - Math.max(fromTop, 0));
  }
  const fromBottom = box.bottom - point.y;
  if (fromBottom < AUTO_SCROLL_ZONE) {
    return ramp(AUTO_SCROLL_ZONE - Math.max(fromBottom, 0));
  }
  return 0;
}

/** Хук ленты: `active` — идёт свой перенос (страницы ленты, а не чужое перетаскивание). */
export function useDragAutoScroll(scrollRef: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) {
      return;
    }
    let point: Point | null = null;
    let seenAt = 0;
    let frame: number | null = null;
    let last = 0;

    const stop = (): void => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    };
    const tick = (now: number): void => {
      frame = null;
      const scroll = scrollRef.current;
      if (scroll === null || point === null || now - seenAt > AUTO_SCROLL_STALE_MS) {
        return;
      }
      const speed = autoScrollSpeed(point, scroll.getBoundingClientRect());
      const limit = scroll.scrollHeight - scroll.clientHeight;
      const atEdge = speed < 0 ? scroll.scrollTop <= 0 : scroll.scrollTop >= limit;
      if (speed === 0 || atEdge) {
        return;
      }
      // Первый кадр после паузы — без шага: время до него — простой, а не ход.
      const dt = last === 0 ? 0 : Math.min(now - last, 100);
      last = now;
      scroll.scrollTop = Math.min(Math.max(scroll.scrollTop + (speed * dt) / 1000, 0), limit);
      frame = requestAnimationFrame(tick);
    };
    const onDragOver = (event: DragEvent): void => {
      point = { x: event.clientX, y: event.clientY };
      seenAt = performance.now();
      if (frame === null) {
        last = 0;
        frame = requestAnimationFrame(tick);
      }
    };

    document.addEventListener('dragover', onDragOver, true);
    return () => {
      document.removeEventListener('dragover', onDragOver, true);
      stop();
    };
  }, [scrollRef, active]);
}
