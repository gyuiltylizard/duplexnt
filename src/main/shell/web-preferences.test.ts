import { describe, expect, it } from 'vitest';
import { buildWebPreferences } from './web-preferences';

describe('buildWebPreferences', () => {
  const prefs = buildWebPreferences('/app/out/preload/index.js', true);

  it('включает sandbox и изоляцию контекста, выключает nodeIntegration', () => {
    expect(prefs.sandbox).toBe(true);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.nodeIntegrationInWorker).toBe(false);
    expect(prefs.nodeIntegrationInSubFrames).toBe(false);
  });

  it('не выключает webSecurity и не пускает небезопасное содержимое', () => {
    expect(prefs.webSecurity).toBe(true);
    expect(prefs.allowRunningInsecureContent).toBe(false);
    expect(prefs.webviewTag).toBe(false);
    expect(prefs.experimentalFeatures).toBe(false);
  });

  it('передаёт путь preload как есть', () => {
    expect(prefs.preload).toBe('/app/out/preload/index.js');
  });

  it('DevTools закрыты упакованному приложению и открыты из out/ (B-29, U3)', () => {
    expect(prefs.devTools).toBe(false);
    expect(buildWebPreferences('/app/out/preload/index.js', false).devTools).toBe(true);
  });

  it('не содержит ничего сверх закрытого списка ключей', () => {
    expect(Object.keys(prefs).sort()).toEqual(
      [
        'allowRunningInsecureContent',
        'contextIsolation',
        'devTools',
        'experimentalFeatures',
        'nodeIntegration',
        'nodeIntegrationInSubFrames',
        'nodeIntegrationInWorker',
        'preload',
        'sandbox',
        'webSecurity',
        'webviewTag',
      ].sort(),
    );
  });
});
