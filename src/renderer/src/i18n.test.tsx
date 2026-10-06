import { ERROR_CODES } from '@shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, i18n, resources } from './i18n';

describe('i18n', () => {
  it('у каждого кода доменной ошибки есть строка в локали, и лишних строк нет', () => {
    for (const [locale, { common }] of Object.entries(resources)) {
      expect(Object.keys(common.errors).sort(), locale).toEqual([...ERROR_CODES].sort());
      for (const text of Object.values(common.errors)) {
        expect(text.trim(), locale).not.toBe('');
      }
    }
  });

  it('варианты по причине лежат под существующими кодами, строки непустые', () => {
    for (const [locale, { common }] of Object.entries(resources)) {
      for (const [code, group] of Object.entries(common.errorReasons)) {
        expect([...ERROR_CODES], locale).toContain(code);
        for (const text of Object.values(group)) {
          expect(text.trim(), `${locale}: ${code}`).not.toBe('');
        }
      }
    }
  });

  it('рабочих терминов «пачка» и «стопка» в текстах интерфейса нет (решения автора, M1/M2)', () => {
    for (const [locale, bundle] of Object.entries(resources)) {
      expect(JSON.stringify(bundle), locale).not.toMatch(/пачк|стопк/iu);
    }
  });

  it('инициализирован синхронно русской локалью', () => {
    expect(i18n.isInitialized).toBe(true);
    expect(i18n.language).toBe(DEFAULT_LOCALE);
    expect(Object.keys(resources)).toEqual(['ru']);
  });

  it.each([
    [1, '1 документ'],
    [2, '2 документа'],
    [5, '5 документов'],
  ])('счётчик документов: %i → %s', (count, expected) => {
    expect(i18n.t('inspector.docsCount', { count })).toBe(expected);
  });

  it.each([
    [0, '0 документов'],
    [11, '11 документов'],
    [21, '21 документ'],
    [101, '101 документ'],
    [112, '112 документов'],
    [1.5, '1.5 документа'],
  ])('края русской плюрализации: %d → %s', (count, expected) => {
    expect(i18n.t('inspector.docsCount', { count })).toBe(expected);
  });

  it('ключи типизированы: несуществующий ключ не проходит typecheck', () => {
    // Рантайм-проверки здесь нет — сценарий закрыт типами. Директива ниже сама станет ошибкой
    // компиляции, если типизация ключей когда-нибудь отвалится.
    // @ts-expect-error — такого ключа в locales/ru/common.json нет
    const missing: string = i18n.t('app.titel');
    expect(missing).toBe('app.titel');
  });
});
