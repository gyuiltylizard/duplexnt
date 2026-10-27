import { cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_SCROLL_MAX,
  AUTO_SCROLL_MIN,
  AUTO_SCROLL_ZONE,
  autoScrollSpeed,
  useDragAutoScroll,
} from './useDragAutoScroll';

// Автопрокрутка ленты при переносе (B-10). Раскладки в jsdom нет: прямоугольник, высоты и
// `scrollTop` ленты подменены, кадры и время — ручные.

const BOX = { left: 0, right: 288, top: 100, bottom: 700 };

describe('autoScrollSpeed (B-10, KTD-2)', () => {
  it('середина ленты — 0', () => {
    expect(autoScrollSpeed({ x: 100, y: 400 }, BOX)).toBe(0);
  });

  it('зона у края: на внутренней границе — минимум, у края — максимум, растёт к краю', () => {
    expect(autoScrollSpeed({ x: 100, y: BOX.top + AUTO_SCROLL_ZONE - 0.001 }, BOX)).toBeCloseTo(
      -AUTO_SCROLL_MIN,
      0,
    );
    expect(autoScrollSpeed({ x: 100, y: BOX.top }, BOX)).toBe(-AUTO_SCROLL_MAX);
    const outer = autoScrollSpeed({ x: 100, y: BOX.top + 10 }, BOX);
    const inner = autoScrollSpeed({ x: 100, y: BOX.top + 30 }, BOX);
    expect(outer).toBeLessThan(inner);
    expect(autoScrollSpeed({ x: 100, y: BOX.bottom - 10 }, BOX)).toBe(-outer);
  });

  it('за краем в пределах ширины — максимум в ту сторону', () => {
    expect(autoScrollSpeed({ x: 100, y: BOX.top - 40 }, BOX)).toBe(-AUTO_SCROLL_MAX);
    expect(autoScrollSpeed({ x: 100, y: BOX.bottom + 40 }, BOX)).toBe(AUTO_SCROLL_MAX);
  });

  it('вбок за лентой — 0, даже на высоте края', () => {
    expect(autoScrollSpeed({ x: 300, y: BOX.top }, BOX)).toBe(0);
    expect(autoScrollSpeed({ x: -1, y: BOX.bottom }, BOX)).toBe(0);
  });
});

function Rail({ active }: { readonly active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useDragAutoScroll(ref, active);
  return <div ref={ref} data-testid="scroll" />;
}

describe('useDragAutoScroll (B-10, KTD-1, KTD-3)', () => {
  let now = 0;
  let frames: FrameRequestCallback[] = [];
  let scrollTop = 0;

  beforeEach(() => {
    now = 1000;
    frames = [];
    scrollTop = 1000;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {
      frames = [];
    });
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Лента 600 px высотой, содержимого 3000 px, прокручена на 1000. */
  function mount(active: boolean) {
    const view = render(<Rail active={active} />);
    const scroll = view.getByTestId('scroll');
    scroll.getBoundingClientRect = () =>
      ({ ...BOX, x: 0, y: 100, width: 288, height: 600 }) as DOMRect;
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 3000 });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 600 });
    Object.defineProperty(scroll, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    return view;
  }
  const dragOver = (y: number, x = 100): void => {
    const event = new Event('dragover', { bubbles: true, cancelable: true });
    Object.assign(event, { clientX: x, clientY: y });
    document.body.dispatchEvent(event);
  };
  /** Прогнать `count` кадров по 16 мс. */
  const run = (count: number): void => {
    for (let index = 0; index < count; index += 1) {
      const pending = frames;
      frames = [];
      now += 16;
      for (const callback of pending) callback(now);
    }
  };

  it('у верхнего края лента едет вверх кадр за кадром, у нижнего — вниз', () => {
    mount(true);

    dragOver(BOX.top);
    run(1); // первый кадр — без шага
    run(3);
    const up = scrollTop;
    expect(up).toBeCloseTo(1000 - (AUTO_SCROLL_MAX * 48) / 1000, 5);

    dragOver(BOX.bottom);
    run(4);
    expect(scrollTop).toBeGreaterThan(up);
  });

  it('указатель ушёл в середину — стоп; вернулся к краю — снова едет', () => {
    mount(true);
    dragOver(BOX.top);
    run(3);
    dragOver(400);
    run(1);
    const stopped = scrollTop;
    run(5);
    expect(scrollTop).toBe(stopped);
    expect(frames).toHaveLength(0);

    dragOver(BOX.top);
    run(3);
    expect(scrollTop).toBeLessThan(stopped);
  });

  it('`dragover` не приходил дольше 400 мс — стоп (потерянный `dragend`)', () => {
    mount(true);
    dragOver(BOX.top);
    run(2);
    now += 500;
    const before = scrollTop;
    run(1);
    expect(scrollTop).toBe(before);
    expect(frames).toHaveLength(0);
  });

  it('у начала ленты не уходит за ноль и останавливается', () => {
    scrollTop = 5;
    mount(true);
    dragOver(BOX.top - 50);
    run(10);
    expect(scrollTop).toBe(0);
    expect(frames).toHaveLength(0);
  });

  it('перенос кончился (`active = false`) — слушатель снят, лента стоит', () => {
    const view = mount(true);
    dragOver(BOX.top);
    run(2);
    view.rerender(<Rail active={false} />);
    const before = scrollTop;
    dragOver(BOX.top);
    run(5);
    expect(scrollTop).toBe(before);
  });

  it('чужое перетаскивание (хук не активен) ленту не двигает', () => {
    mount(false);
    dragOver(BOX.top);
    run(5);
    expect(scrollTop).toBe(1000);
    expect(frames).toHaveLength(0);
  });
});
