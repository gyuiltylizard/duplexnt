import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ET_3850, fixturePath, fixtureRepoPath, readFixture, readFixtureText } from './fixtures';
import { describeLive, LIVE_DEVICE_ENV, liveDeviceHost } from './live-device';

describe('помощник путей к фикстурам', () => {
  it('даёт абсолютный путь к существующей фикстуре и путь от корня репозитория', () => {
    const path = fixturePath(...ET_3850, 'ScannerCapabilities.xml');

    expect(isAbsolute(path)).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(fixtureRepoPath(...ET_3850, 'traces', 'empty-tray.json')).toBe(
      'test/fixtures/escl/et-3850/traces/empty-tray.json',
    );
  });

  it('читает фикстуру байт в байт', () => {
    const bytes = readFixture(...ET_3850, 'ScannerStatus.xml');

    expect(bytes.subarray(0, 5).toString('latin1')).toBe('<?xml');
    expect(readFixtureText(...ET_3850, 'ScannerStatus.xml')).toBe(bytes.toString('utf8'));
  });

  it('не выпускает путь из каталога фикстур', () => {
    expect(() => fixturePath('..', 'guards', 'privacy-guard.test.ts')).toThrow(/фикстур/);
    expect(() => fixturePath('escl/../../guards')).toThrow(/фикстур/);
    expect(() => fixturePath('C:\\Windows')).toThrow(/фикстур/);
    expect(() => fixtureRepoPath('escl', '')).toThrow(/фикстур/);
  });
});

describe('прогон против живого устройства', () => {
  function fakeSuite() {
    const ran: string[] = [];
    const skipped: string[] = [];
    const suite = Object.assign(
      (name: string, body: () => void) => {
        ran.push(name);
        body();
      },
      {
        // Тело пропущенного набора не исполняется: внутри него `it`, которому здесь не место.
        skip: (name: string) => {
          skipped.push(name);
        },
      },
    );
    return { suite, ran, skipped };
  }

  it('без переменной окружения набор пропускается с предупреждением, тело не вызывается', () => {
    const { suite, ran, skipped } = fakeSuite();
    const warn = vi.fn<(message: string) => void>();
    const body = vi.fn<(host: string) => void>();

    describeLive('задание автоподачи', body, { env: {}, warn, suite });

    expect(skipped).toEqual(['задание автоподачи']);
    expect(ran).toEqual([]);
    expect(body).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(LIVE_DEVICE_ENV));
  });

  it('с переменной набор идёт, тело получает адрес, предупреждения нет', () => {
    const { suite, ran, skipped } = fakeSuite();
    const warn = vi.fn<(message: string) => void>();
    const body = vi.fn<(host: string) => void>();

    describeLive('задание автоподачи', body, {
      env: { [LIVE_DEVICE_ENV]: ' 192.0.2.10 ' },
      warn,
      suite,
    });

    expect(ran).toEqual(['задание автоподачи']);
    expect(skipped).toEqual([]);
    expect(body).toHaveBeenCalledExactlyOnceWith('192.0.2.10');
    expect(warn).not.toHaveBeenCalled();
  });

  it('пустая переменная — то же, что её отсутствие', () => {
    expect(liveDeviceHost({ [LIVE_DEVICE_ENV]: '   ' })).toBeNull();
    expect(liveDeviceHost({})).toBeNull();
  });
});
