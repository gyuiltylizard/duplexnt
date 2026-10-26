import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WindowState } from '@core';
import { placeWindow, trackWindowState, type Rect } from './window-bounds';

const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const RIGHT: Rect = { x: 1920, y: 0, width: 2560, height: 1400 };

const stateAt = (bounds: Rect, maximized = false): WindowState => ({ bounds, maximized });

describe('где открыть окно (B-3)', () => {
  it('помнить нечего — по умолчанию, не развёрнуто', () => {
    expect(placeWindow(null, [PRIMARY])).toEqual({ bounds: null, maximized: false });
  });

  it('окно на мониторе — как было, вместе с признаком «развёрнуто»', () => {
    const saved = stateAt({ x: 2100, y: 120, width: 1600, height: 1000 }, true);

    expect(placeWindow(saved, [PRIMARY, RIGHT])).toEqual(saved);
  });

  it('монитор, на котором было окно, отключён — по умолчанию; «развёрнуто» в силе', () => {
    const saved = stateAt({ x: 2100, y: 120, width: 1600, height: 1000 }, true);

    expect(placeWindow(saved, [PRIMARY])).toEqual({ bounds: null, maximized: true });
  });

  it('частично за краем, но заголовок виден — как было', () => {
    const saved = stateAt({ x: 1700, y: 300, width: 1100, height: 760 });

    expect(placeWindow(saved, [PRIMARY])).toEqual(saved);
  });

  it('за краем остался лишь краешек заголовка — по умолчанию', () => {
    const saved = stateAt({ x: 1850, y: 300, width: 1100, height: 760 });

    expect(placeWindow(saved, [PRIMARY]).bounds).toBeNull();
  });

  it('заголовок выше рабочей области — по умолчанию: окно не за что утащить', () => {
    const saved = stateAt({ x: 100, y: -500, width: 1100, height: 760 });

    expect(placeWindow(saved, [PRIMARY]).bounds).toBeNull();
  });

  it('больше рабочей области (монитор сменили на меньший) — ужато до неё и сдвинуто внутрь', () => {
    const saved = stateAt({ x: 200, y: 20, width: 2400, height: 1300 });

    expect(placeWindow(saved, [PRIMARY]).bounds).toEqual(PRIMARY);
  });
});

interface FakeWindow {
  readonly emit: (event: string) => void;
  bounds: Rect;
  maximized: boolean;
  minimized: boolean;
}

function fakeWindow(): FakeWindow & Parameters<typeof trackWindowState>[0] {
  const listeners = new Map<string, (() => void)[]>();
  const window = {
    bounds: { x: 10, y: 20, width: 1100, height: 760 },
    maximized: false,
    minimized: false,
    emit: (event: string) => {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
    on: (event: string, listener: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    isMaximized: () => window.maximized,
    isMinimized: () => window.minimized,
    getNormalBounds: () => window.bounds,
  };
  return window;
}

describe('слежение за окном (B-3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('серия перемещений и растягиваний — одна запись, последнее место', () => {
    const window = fakeWindow();
    const save = vi.fn();
    trackWindowState(window, save, 500);

    window.emit('moved');
    window.bounds = { x: 300, y: 200, width: 1100, height: 760 };
    window.emit('resized');
    window.bounds = { x: 300, y: 200, width: 1500, height: 950 };
    vi.advanceTimersByTime(499);
    expect(save).not.toHaveBeenCalled();
    window.emit('resized');
    vi.advanceTimersByTime(500);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      bounds: { x: 300, y: 200, width: 1500, height: 950 },
      maximized: false,
    });
  });

  it('развёрнутое — признак и границы до разворота', () => {
    const window = fakeWindow();
    const save = vi.fn();
    trackWindowState(window, save, 500);

    window.maximized = true;
    window.emit('maximize');
    vi.advanceTimersByTime(500);

    expect(save).toHaveBeenCalledWith({
      bounds: { x: 10, y: 20, width: 1100, height: 760 },
      maximized: true,
    });
  });

  it('закрытие пишет сразу и снимает отложенную запись', () => {
    const window = fakeWindow();
    const save = vi.fn();
    trackWindowState(window, save, 500);

    window.emit('resized');
    window.emit('close');
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('свёрнутое окно не пишется: в силе последнее записанное', () => {
    const window = fakeWindow();
    const save = vi.fn();
    trackWindowState(window, save, 500);

    window.minimized = true;
    window.emit('close');

    expect(save).not.toHaveBeenCalled();
  });

  it('дробные границы (масштаб монитора) округляются: схема файла — целые', () => {
    const window = fakeWindow();
    const save = vi.fn();
    trackWindowState(window, save, 500);

    window.bounds = { x: 10.4, y: 20.6, width: 1100.5, height: 760.2 };
    window.emit('close');

    expect(save).toHaveBeenCalledWith({
      bounds: { x: 10, y: 21, width: 1101, height: 760 },
      maximized: false,
    });
  });
});
