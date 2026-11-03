import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES, localeOfSystemTag, resolveLocale } from './locale';

describe('язык интерфейса (B-41)', () => {
  it('словарь — русский и английский, по умолчанию русский', () => {
    expect(LOCALES).toEqual(['ru', 'en']);
    expect(DEFAULT_LOCALE).toBe('ru');
  });

  it.each([
    ['ru', 'ru'],
    ['ru-RU', 'ru'],
    ['ru_RU', 'ru'],
    ['RU', 'ru'],
    ['en-US', 'en'],
    ['en', 'en'],
    ['uk', 'en'],
    ['be-BY', 'en'],
    ['de', 'en'],
    ['', 'en'],
    ['rus', 'en'],
  ])('системная метка %j → %s', (tag, expected) => {
    expect(localeOfSystemTag(tag)).toBe(expected);
  });

  it('явный выбор побеждает системный, «следовать системе» берёт системный', () => {
    expect(resolveLocale(null, 'en')).toBe('en');
    expect(resolveLocale(null, 'ru')).toBe('ru');
    expect(resolveLocale('ru', 'en')).toBe('ru');
    expect(resolveLocale('en', 'ru')).toBe('en');
  });
});
