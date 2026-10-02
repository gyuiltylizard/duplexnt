import { describe, expect, it, vi } from 'vitest';
import { acquireSingleInstance } from './single-instance';

function fakeApp(lockFree: boolean) {
  const listeners: (() => void)[] = [];
  const app = {
    requestSingleInstanceLock: vi.fn(() => lockFree),
    quit: vi.fn(),
    on: vi.fn((_event: 'second-instance', listener: () => void) => {
      listeners.push(listener);
    }),
  };
  const secondInstance = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };
  return { app, secondInstance };
}

function fakeWindow(state: { destroyed?: boolean; minimized?: boolean } = {}) {
  const order: string[] = [];
  return {
    order,
    isDestroyed: () => state.destroyed ?? false,
    isMinimized: () => state.minimized ?? false,
    restore: () => {
      order.push('restore');
    },
    focus: () => {
      order.push('focus');
    },
  };
}

describe('acquireSingleInstance', () => {
  it('блокировка занята: приложение завершается, окно не запрашивается, слушателя нет', () => {
    const { app } = fakeApp(false);
    const getWindow = vi.fn(() => null);

    expect(acquireSingleInstance(app, getWindow)).toBe(false);
    expect(app.quit).toHaveBeenCalledOnce();
    expect(app.on).not.toHaveBeenCalled();
    expect(getWindow).not.toHaveBeenCalled();
  });

  it('блокировка свободна: приложение продолжает запуск и не завершается', () => {
    const { app } = fakeApp(true);

    expect(acquireSingleInstance(app, () => null)).toBe(true);
    expect(app.quit).not.toHaveBeenCalled();
    expect(app.on).toHaveBeenCalledExactlyOnceWith('second-instance', expect.any(Function));
  });

  it('второй экземпляр восстанавливает свёрнутое окно и даёт ему фокус', () => {
    const { app, secondInstance } = fakeApp(true);
    const window = fakeWindow({ minimized: true });
    acquireSingleInstance(app, () => window);

    secondInstance();

    expect(window.order).toEqual(['restore', 'focus']);
  });

  it('несвёрнутое окно получает фокус без восстановления', () => {
    const { app, secondInstance } = fakeApp(true);
    const window = fakeWindow();
    acquireSingleInstance(app, () => window);

    secondInstance();

    expect(window.order).toEqual(['focus']);
  });

  it('окна ещё нет или оно разрушено — событие второго экземпляра не бросает', () => {
    const { app, secondInstance } = fakeApp(true);
    let window: ReturnType<typeof fakeWindow> | null = null;
    acquireSingleInstance(app, () => window);

    expect(secondInstance).not.toThrow();

    window = fakeWindow({ destroyed: true });
    expect(secondInstance).not.toThrow();
    expect(window.order).toEqual([]);
  });

  it('окно берётся в момент события, а не при получении блокировки', () => {
    const { app, secondInstance } = fakeApp(true);
    let window: ReturnType<typeof fakeWindow> | null = null;
    acquireSingleInstance(app, () => window);

    window = fakeWindow();
    secondInstance();

    expect(window.order).toEqual(['focus']);
  });
});
