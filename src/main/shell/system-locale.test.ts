import { describe, expect, it } from 'vitest';
import { startupStringsOf, systemLocaleOf } from './system-locale';

// Язык main (B-41, U3): системная метка → локаль по правилу `ru*`; строки диалога запуска —
// из бандла нужного языка.

describe('systemLocaleOf', () => {
  it.each([
    ['ru-RU', 'ru'],
    ['ru', 'ru'],
    ['en-US', 'en'],
    ['uk', 'en'],
    ['', 'en'],
  ])('%j → %s', (tag, expected) => {
    expect(systemLocaleOf({ getLocale: () => tag })).toBe(expected);
  });
});

describe('startupStringsOf', () => {
  it('английский — английские строки «хранилище не читается»', () => {
    const strings = startupStringsOf('en');
    expect(strings.title).toBe('Could not read the app data');
    expect(strings.text).toContain('data folder');
  });

  it('русский — русские строки', () => {
    const strings = startupStringsOf('ru');
    expect(strings.title).toBe('Не удалось прочитать данные приложения');
    expect(strings.text).toContain('Папка с данными');
  });
});
