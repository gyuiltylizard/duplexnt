import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { blockBrowserShortcuts, installShortcutGuard, isBrowserShortcut } from './shortcuts';

// Браузерные клавиши в упакованном приложении (решение автора, M1): перезагрузка, DevTools,
// масштаб, «назад» и «вперёд» не срабатывают; обычный ввод проходит.

const key = (
  code: string,
  mods: Partial<{ control: boolean; meta: boolean; shift: boolean; alt: boolean }> = {},
) => ({
  type: 'keyDown' as const,
  code,
  control: false,
  meta: false,
  shift: false,
  alt: false,
  ...mods,
});

describe('isBrowserShortcut', () => {
  it.each([
    ['Ctrl+R', key('KeyR', { control: true })],
    ['Ctrl+Shift+R', key('KeyR', { control: true, shift: true })],
    ['F5', key('F5')],
    ['Ctrl+F5', key('F5', { control: true })],
    ['Shift+F5', key('F5', { shift: true })],
    ['F12', key('F12')],
    ['Ctrl+Shift+I', key('KeyI', { control: true, shift: true })],
    ['Ctrl+Shift+J', key('KeyJ', { control: true, shift: true })],
    ['Ctrl+Shift+C', key('KeyC', { control: true, shift: true })],
    ['Ctrl+=', key('Equal', { control: true })],
    ['Ctrl+Shift+= (Ctrl++)', key('Equal', { control: true, shift: true })],
    ['Ctrl+-', key('Minus', { control: true })],
    ['Ctrl+0', key('Digit0', { control: true })],
    ['Ctrl+Numpad+', key('NumpadAdd', { control: true })],
    ['Ctrl+P', key('KeyP', { control: true })],
    ['Ctrl+U', key('KeyU', { control: true })],
    ['Alt+←', key('ArrowLeft', { alt: true })],
    ['Alt+→', key('ArrowRight', { alt: true })],
    ['кнопка «назад» мыши/клавиатуры', key('BrowserBack')],
    ['кнопка «обновить»', key('BrowserRefresh')],
    ['Cmd+R', key('KeyR', { meta: true })],
  ])('блокирует %s', (_name, input) => {
    expect(isBrowserShortcut(input)).toBe(true);
  });

  it('в русской раскладке Ctrl+К — та же физическая клавиша R', () => {
    // Electron отдаёт `key: 'к'`, но `code` у клавиши один: `KeyR`.
    expect(isBrowserShortcut(key('KeyR', { control: true }))).toBe(true);
  });

  it.each([
    ['R без модификаторов', key('KeyR')],
    ['Shift+R', key('KeyR', { shift: true })],
    ['Ctrl+C', key('KeyC', { control: true })],
    ['Ctrl+V', key('KeyV', { control: true })],
    ['Ctrl+A', key('KeyA', { control: true })],
    ['Ctrl+I без Shift', key('KeyI', { control: true })],
    ['стрелка влево', key('ArrowLeft')],
    ['Ctrl+← (по словам в поле)', key('ArrowLeft', { control: true })],
    ['Home', key('Home')],
    ['Enter', key('Enter')],
    ['Escape', key('Escape')],
    ['Tab', key('Tab')],
    ['цифра 0', key('Digit0')],
  ])('пропускает %s', (_name, input) => {
    expect(isBrowserShortcut(input)).toBe(false);
  });

  it('отпускание клавиши не трогает', () => {
    expect(isBrowserShortcut({ ...key('KeyR', { control: true }), type: 'keyUp' })).toBe(false);
  });
});

describe('blockBrowserShortcuts', () => {
  it('гасит браузерное сочетание до страницы и пропускает обычный ввод', () => {
    const emitter = new EventEmitter();
    blockBrowserShortcuts(emitter as unknown as WebContents);

    const reload = { preventDefault: vi.fn() };
    emitter.emit('before-input-event', reload, key('KeyR', { control: true }));
    const typing = { preventDefault: vi.fn() };
    emitter.emit('before-input-event', typing, key('KeyR'));

    expect(reload.preventDefault).toHaveBeenCalledOnce();
    expect(typing.preventDefault).not.toHaveBeenCalled();
  });
});

describe('installShortcutGuard', () => {
  it('в упакованном приложении вешается на каждое новое webContents', () => {
    const app = Object.assign(new EventEmitter(), { isPackaged: true });
    const contents = new EventEmitter();

    expect(installShortcutGuard(app)).toBe(true);
    app.emit('web-contents-created', {}, contents);

    const reload = { preventDefault: vi.fn() };
    contents.emit('before-input-event', reload, key('F5'));
    expect(reload.preventDefault).toHaveBeenCalledOnce();
  });

  it('в dev ничего не вешает: перезагрузка и DevTools нужны для работы', () => {
    const app = Object.assign(new EventEmitter(), { isPackaged: false });
    const on = vi.spyOn(app, 'on');

    expect(installShortcutGuard(app)).toBe(false);
    expect(on).not.toHaveBeenCalled();
  });
});
