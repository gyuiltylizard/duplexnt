import { describe, expect, it, vi } from 'vitest';
import { installWindowClose } from './window-close';

// Закрытие окна во время прохода (план M1, KTD-26): первое закрытие откладывается до прерывания,
// окно уничтожается после него; без прохода закрытие идёт как обычно.

function setup(running: boolean) {
  let interruptResolve: (() => void) | null = null;
  const interrupt = vi.fn(
    (deadlineMs: number) =>
      new Promise<void>((resolve) => {
        expect(deadlineMs).toBeGreaterThan(0);
        interruptResolve = resolve;
      }),
  );
  let listener: ((event: { preventDefault(): void }) => void) | null = null;
  const destroy = vi.fn();
  const window = {
    on: (_event: 'close', handler: (event: { preventDefault(): void }) => void) => {
      listener = handler;
    },
    destroy,
  };
  installWindowClose(window, { isPassRunning: () => running, interrupt }, 1234);

  const close = () => {
    const preventDefault = vi.fn();
    if (listener === null) {
      throw new Error('обработчик close не установлен');
    }
    listener({ preventDefault });
    return preventDefault;
  };
  const finishInterrupt = async (): Promise<void> => {
    interruptResolve?.();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { interrupt, destroy, close, finishInterrupt };
}

describe('installWindowClose', () => {
  it('без прохода закрытие не откладывается и прерывание не зовётся', () => {
    const { interrupt, destroy, close } = setup(false);

    const preventDefault = close();

    expect(preventDefault).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it('во время прохода: закрытие отложено, прерывание со сроком, окно уничтожается после', async () => {
    const { interrupt, destroy, close, finishInterrupt } = setup(true);

    const preventDefault = close();

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(interrupt).toHaveBeenCalledExactlyOnceWith(1234);
    expect(destroy).not.toHaveBeenCalled();
    await finishInterrupt();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('повторное закрытие во время прерывания не прерывает второй раз и не закрывает раньше', async () => {
    const { interrupt, destroy, close, finishInterrupt } = setup(true);

    close();
    const second = close();

    expect(second).toHaveBeenCalledOnce();
    expect(interrupt).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
    await finishInterrupt();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
