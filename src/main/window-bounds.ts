import type { WindowBounds, WindowState } from '@core';

// Размер и положение окна между запусками (B-3). Electron не импортируется: окно и мониторы
// описаны структурно, расстановка и слежение проверяются под обычным Node.

/** Размер окна, когда помнить нечего или сохранённое место не на мониторе. */
export const DEFAULT_WINDOW_SIZE = { width: 1100, height: 760 } as const;

/** Задержка записи: перетаскивание и растягивание дают серию событий — пишется последнее. */
export const WINDOW_SAVE_DELAY_MS = 500;

/**
 * Окно видимо, если полоса заголовка — верх окна высотой `TITLE_STRIP` — заходит на рабочую
 * область монитора хотя бы на `VISIBLE_WIDTH` × `VISIBLE_HEIGHT`: за неё окно можно утащить.
 */
const TITLE_STRIP = 32;
const VISIBLE_WIDTH = 100;
const VISIBLE_HEIGHT = 16;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowPlacement {
  /** Границы окна; `null` — размер по умолчанию на основном мониторе. */
  readonly bounds: WindowBounds | null;
  readonly maximized: boolean;
}

function overlap(a: Rect, b: Rect): { readonly width: number; readonly height: number } {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
  };
}

/**
 * Где открыть окно: сохранённые границы, если заголовок попадает на один из нынешних мониторов,
 * иначе — по умолчанию (монитор отключили). Окно больше рабочей области ужимается до неё и
 * сдвигается внутрь. Признак «развёрнуто» в силе в обоих случаях.
 */
export function placeWindow(
  saved: WindowState | null,
  workAreas: readonly Rect[],
): WindowPlacement {
  if (saved === null) {
    return { bounds: null, maximized: false };
  }
  const { bounds, maximized } = saved;
  const strip: Rect = { ...bounds, height: Math.min(TITLE_STRIP, bounds.height) };
  const area = workAreas.find((candidate) => {
    const shared = overlap(strip, candidate);
    return shared.width >= VISIBLE_WIDTH && shared.height >= VISIBLE_HEIGHT;
  });
  if (area === undefined) {
    return { bounds: null, maximized };
  }
  if (bounds.width <= area.width && bounds.height <= area.height) {
    return { bounds, maximized };
  }
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  const inside = (start: number, length: number, from: number, span: number): number =>
    Math.min(Math.max(start, from), from + span - length);
  return {
    bounds: {
      x: inside(bounds.x, width, area.x, area.width),
      y: inside(bounds.y, height, area.y, area.height),
      width,
      height,
    },
    maximized,
  };
}

type TrackedEvent = 'moved' | 'resized' | 'maximize' | 'unmaximize' | 'close';

interface TrackedWindow {
  on(event: TrackedEvent, listener: () => void): unknown;
  isMaximized(): boolean;
  isMinimized(): boolean;
  /** Границы обычного окна — и у развёрнутого: к ним вернёт «Восстановить». */
  getNormalBounds(): Rect;
}

/**
 * Следит за окном и отдаёт его состояние на запись: после перемещения, растягивания и разворота —
 * с задержкой, при закрытии — сразу. Свёрнутое окно не пишется: у него нет своего места, в силе
 * последнее записанное.
 */
export function trackWindowState(
  window: TrackedWindow,
  save: (state: WindowState) => void,
  delayMs = WINDOW_SAVE_DELAY_MS,
): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (window.isMinimized()) {
      return;
    }
    const { x, y, width, height } = window.getNormalBounds();
    save({
      bounds: {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
      },
      maximized: window.isMaximized(),
    });
  };
  const schedule = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(flush, delayMs);
  };
  for (const event of ['moved', 'resized', 'maximize', 'unmaximize'] as const) {
    window.on(event, schedule);
  }
  window.on('close', flush);
}
