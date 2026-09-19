import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { guardWebContents, isSameDocument } from './guards';

function fakeContents(currentUrl: string) {
  const emitter = new EventEmitter();
  const setWindowOpenHandler = vi.fn();
  const contents = Object.assign(emitter, {
    getURL: () => currentUrl,
    setWindowOpenHandler,
  }) as unknown as WebContents;
  return { contents, emitter, setWindowOpenHandler };
}

describe('isSameDocument', () => {
  it('считает перезагрузку и смену якоря той же страницей', () => {
    expect(isSameDocument('http://localhost:5173/', 'http://localhost:5173/')).toBe(true);
    expect(isSameDocument('file:///app/index.html', 'file:///app/index.html#x')).toBe(true);
  });

  it('не считает той же страницей чужой адрес и пустой текущий', () => {
    expect(isSameDocument('file:///app/index.html', 'https://example.com/')).toBe(false);
    expect(isSameDocument('', 'https://example.com/')).toBe(false);
  });
});

describe('guardWebContents', () => {
  it('отклоняет навигацию на чужой адрес и пропускает перезагрузку', () => {
    const { contents, emitter } = fakeContents('file:///app/index.html');
    guardWebContents(contents);

    const foreign = { preventDefault: vi.fn() };
    emitter.emit('will-navigate', foreign, 'https://example.com/');
    expect(foreign.preventDefault).toHaveBeenCalledOnce();

    const reload = { preventDefault: vi.fn() };
    emitter.emit('will-navigate', reload, 'file:///app/index.html');
    expect(reload.preventDefault).not.toHaveBeenCalled();
  });

  it('отклоняет редиректы, webview и новые окна', () => {
    const { contents, emitter, setWindowOpenHandler } = fakeContents('file:///app/index.html');
    guardWebContents(contents);

    for (const name of ['will-redirect', 'will-attach-webview']) {
      const event = { preventDefault: vi.fn() };
      emitter.emit(name, event);
      expect(event.preventDefault, name).toHaveBeenCalledOnce();
    }

    const handler = setWindowOpenHandler.mock.calls[0]?.[0] as () => { action: string };
    expect(handler()).toEqual({ action: 'deny' });
  });
});
