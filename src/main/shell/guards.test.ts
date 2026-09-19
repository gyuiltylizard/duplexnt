import { EventEmitter } from 'node:events';
import type { App, Session, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { denyAllPermissions, guardWebContents, installShellGuards, isSameDocument } from './guards';

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

describe('installShellGuards', () => {
  it('вешает гварды на каждое новое webContents', () => {
    const app = new EventEmitter();
    installShellGuards(app as unknown as App);

    const first = fakeContents('file:///app/index.html');
    const second = fakeContents('file:///app/index.html');
    app.emit('web-contents-created', {}, first.contents);
    app.emit('web-contents-created', {}, second.contents);

    for (const { emitter, setWindowOpenHandler } of [first, second]) {
      const event = { preventDefault: vi.fn() };
      emitter.emit('will-navigate', event, 'https://example.com/');
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(setWindowOpenHandler).toHaveBeenCalledOnce();
    }
  });
});

describe('denyAllPermissions', () => {
  it('отвечает отказом на запрос, проверку и доступ к устройству', () => {
    const session = {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
    };
    denyAllPermissions(session as unknown as Session);

    const onRequest = session.setPermissionRequestHandler.mock.calls[0]?.[0] as (
      contents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void;
    const callback = vi.fn();
    onRequest({}, 'media', callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);

    const onCheck = session.setPermissionCheckHandler.mock.calls[0]?.[0] as () => boolean;
    const onDevice = session.setDevicePermissionHandler.mock.calls[0]?.[0] as () => boolean;
    expect(onCheck()).toBe(false);
    expect(onDevice()).toBe(false);
  });
});
