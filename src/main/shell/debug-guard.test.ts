import { describe, expect, it, vi } from 'vitest';
import { DEBUG_SWITCHES, installDebugGuard } from './debug-guard';

// Ключи отладки в упакованном приложении (B-29, U3): порт и pipe — выход до любого запуска;
// без ключей и из `out/` запуск идёт.

function app(isPackaged: boolean, switches: readonly string[]) {
  const hasSwitch = vi.fn((name: string) => switches.includes(name));
  return { app: { isPackaged, commandLine: { hasSwitch } }, hasSwitch };
}

describe('installDebugGuard', () => {
  it('закрывает ровно порт и pipe протокола DevTools', () => {
    expect(DEBUG_SWITCHES).toEqual(['remote-debugging-port', 'remote-debugging-pipe']);
  });

  it.each([['remote-debugging-port'], ['remote-debugging-pipe']])(
    'упаковано + --%s → выход с кодом 1, дальше запуск не идёт',
    (name) => {
      const exit = vi.fn();
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      expect(installDebugGuard(app(true, [name]).app, exit)).toBe(true);

      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(error).toHaveBeenCalledOnce();
      expect(String(error.mock.calls[0]?.[0])).toContain(`--${name}`);
      error.mockRestore();
    },
  );

  it('упаковано без ключей → запуск идёт, ключи проверены', () => {
    const exit = vi.fn();
    const { app: packaged, hasSwitch } = app(true, ['user-data-dir']);

    expect(installDebugGuard(packaged, exit)).toBe(false);

    expect(exit).not.toHaveBeenCalled();
    expect(hasSwitch.mock.calls.map(([name]) => name)).toEqual([...DEBUG_SWITCHES]);
  });

  it('не упаковано с ключами → запуск идёт, ключи даже не смотрятся', () => {
    const exit = vi.fn();
    const { app: unpacked, hasSwitch } = app(false, [...DEBUG_SWITCHES]);

    expect(installDebugGuard(unpacked, exit)).toBe(false);

    expect(exit).not.toHaveBeenCalled();
    expect(hasSwitch).not.toHaveBeenCalled();
  });
});
