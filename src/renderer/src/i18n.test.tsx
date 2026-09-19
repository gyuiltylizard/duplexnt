import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, i18n, resources } from './i18n';

describe('i18n', () => {
  it('инициализирован синхронно русской локалью', () => {
    expect(i18n.isInitialized).toBe(true);
    expect(i18n.language).toBe(DEFAULT_LOCALE);
    expect(Object.keys(resources)).toEqual(['ru']);
  });

  it.each([
    [1, '1 лист'],
    [2, '2 листа'],
    [5, '5 листов'],
  ])('счётчик листов: %i → %s', (count, expected) => {
    expect(i18n.t('sheets', { count })).toBe(expected);
  });

  it.each([
    [0, '0 листов'],
    [11, '11 листов'],
    [21, '21 лист'],
    [101, '101 лист'],
    [112, '112 листов'],
    [1.5, '1.5 листа'],
  ])('края русской плюрализации: %d → %s', (count, expected) => {
    expect(i18n.t('sheets', { count })).toBe(expected);
  });

  it('ключи типизированы: несуществующий ключ не проходит typecheck', () => {
    // Рантайм-проверки здесь нет — сценарий закрыт типами. Директива ниже сама станет ошибкой
    // компиляции, если типизация ключей когда-нибудь отвалится.
    // @ts-expect-error — такого ключа в locales/ru/common.json нет
    const missing: string = i18n.t('app.titel');
    expect(missing).toBe('app.titel');
  });
});
