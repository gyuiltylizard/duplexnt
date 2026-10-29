import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Смена кадра на месте (M6; handoff M6 «Смена вида на месте»): в jsdom у `<img>` нет `decode()`
// — хук подменяет адрес сразу (путь ленты в остальных тестах). Здесь `decode()` подставляется до
// загрузки модуля: новый кадр грузится вне DOM, кладётся слоем поверх прежнего, проявляется
// кадром позже и становится показанным по концу перехода (или по страховочному таймеру); сбой
// загрузки и возврат адреса во время загрузки оставляют прежний кадр.

type Decode = () => Promise<void>;
let decode: ReturnType<typeof vi.fn<Decode>>;
let useImageSwap: typeof import('./useImageSwap').useImageSwap;

function Frame({ src }: { readonly src: string }) {
  const swap = useImageSwap(src);
  return (
    <div>
      <img data-testid="shown" src={swap.shown} alt="" />
      {swap.incoming !== null && (
        <img
          data-testid="incoming"
          className={swap.incomingIn ? 'is-in' : ''}
          src={swap.incoming}
          alt=""
          onTransitionEnd={swap.settle}
        />
      )}
    </div>
  );
}

const src = (id: string): string | null =>
  document.querySelector(`[data-testid="${id}"]`)?.getAttribute('src') ?? null;

const incomingLayer = (): Element => {
  const element = document.querySelector('[data-testid="incoming"]');
  if (element === null) {
    throw new Error('слоя нового кадра нет');
  }
  return element;
};

beforeEach(async () => {
  decode = vi.fn<Decode>(() => Promise.resolve());
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    value: decode,
  });
  vi.resetModules();
  ({ useImageSwap } = await import('./useImageSwap'));
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
});

describe('useImageSwap', () => {
  it('новый адрес: прежний кадр показан, новый декодируется вне DOM, проявляется и становится показанным по transitionend', async () => {
    const view = render(<Frame src="a" />);
    expect(src('shown')).toBe('a');
    expect(decode).not.toHaveBeenCalled();

    view.rerender(<Frame src="b" />);
    expect(src('shown')).toBe('a');
    expect(src('incoming')).toBeNull();
    expect(decode).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
    });
    expect(src('shown')).toBe('a');
    expect(src('incoming')).toBe('b');
    expect(incomingLayer().className).toBe('');
    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(incomingLayer().className).toBe('is-in');

    fireEvent.transitionEnd(incomingLayer());
    expect(src('shown')).toBe('b');
    expect(src('incoming')).toBeNull();
  });

  it('переход не пришёл — страховочный таймер делает новый кадр показанным', async () => {
    const view = render(<Frame src="a" />);
    view.rerender(<Frame src="b" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(src('incoming')).toBe('b');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(src('shown')).toBe('b');
    expect(src('incoming')).toBeNull();
  });

  it('сбой загрузки — прежний кадр остаётся, ошибка в лог', async () => {
    decode.mockImplementation(() => Promise.reject(new Error('EncodingError')));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = render(<Frame src="a" />);
    view.rerender(<Frame src="b" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(src('shown')).toBe('a');
    expect(src('incoming')).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('адрес вернулся к показанному, пока новый грузился (быстрый Ctrl+Z), — подмены нет', async () => {
    let finish: () => void = () => undefined;
    decode.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<Frame src="a" />);
    view.rerender(<Frame src="b" />);
    view.rerender(<Frame src="a" />);
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(src('shown')).toBe('a');
    expect(src('incoming')).toBeNull();
  });
});
