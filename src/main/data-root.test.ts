import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDataRoot } from './data-root';

const APP_DATA = join('C:', 'Users', 'u', 'AppData', 'Roaming');

function fakeApp(isPackaged: boolean) {
  const calls: string[] = [];
  let userData = join(APP_DATA, 'duplexnt');
  const app = {
    isPackaged,
    getName: () => 'duplexnt',
    getPath: (name: 'appData' | 'userData') => {
      calls.push(`getPath:${name}`);
      return name === 'appData' ? APP_DATA : userData;
    },
    setPath: (name: 'userData', path: string) => {
      calls.push(`setPath:${name}`);
      userData = path;
    },
  };
  return { app, calls, userData: () => userData };
}

describe('resolveDataRoot', () => {
  it('упакованный запуск: корень — data в стандартном userData, путь не переопределяется', () => {
    const { app, calls, userData } = fakeApp(true);

    expect(resolveDataRoot(app)).toBe(join(APP_DATA, 'duplexnt', 'data'));
    expect(userData()).toBe(join(APP_DATA, 'duplexnt'));
    expect(calls).toEqual(['getPath:userData']);
  });

  it('неупакованный запуск: userData уезжает в соседний каталог, корень — data в нём', () => {
    const { app, userData } = fakeApp(false);

    expect(resolveDataRoot(app)).toBe(join(APP_DATA, 'duplexnt-dev', 'data'));
    expect(userData()).toBe(join(APP_DATA, 'duplexnt-dev'));
  });

  it('неупакованный запуск не запрашивает userData до переопределения', () => {
    const { app, calls } = fakeApp(false);

    resolveDataRoot(app);

    expect(calls).toEqual(['getPath:appData', 'setPath:userData', 'getPath:userData']);
  });

  it('неупакованный запуск: DUPLEXNT_USER_DATA переопределяет каталог целиком', () => {
    const { app, userData } = fakeApp(false);
    const override = join('D:', 'tmp', 'smoke-userdata');

    expect(resolveDataRoot(app, { DUPLEXNT_USER_DATA: override })).toBe(join(override, 'data'));
    expect(userData()).toBe(override);
  });

  it('упакованный запуск переменную окружения не уважает', () => {
    const { app } = fakeApp(true);

    expect(resolveDataRoot(app, { DUPLEXNT_USER_DATA: join('D:', 'tmp') })).toBe(
      join(APP_DATA, 'duplexnt', 'data'),
    );
  });

  it('каталог dev не совпадает с каталогом установленного приложения и не вложен в него', () => {
    const dev = resolveDataRoot(fakeApp(false).app);
    const installed = resolveDataRoot(fakeApp(true).app);

    expect(dev).not.toBe(installed);
    expect(dev.startsWith(join(APP_DATA, 'duplexnt') + sep)).toBe(false);
  });
});
