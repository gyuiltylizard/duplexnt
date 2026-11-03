import { ERROR_CODES, LOCALES } from '@shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, i18n, resources } from './i18n';

/** Листовые ключи бандла с путями через точку: `{ a: { b_one: 'x' } }` → `['a.b_one']`. */
function leafKeys(bundle: object, prefix = ''): string[] {
  return Object.entries(bundle).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : leafKeys(value as object, `${prefix}${key}.`),
  );
}

const PLURAL_SUFFIX = /_(?:zero|one|two|few|many|other)$/u;

/** Базовое имя ключа — без суффикса формы плюрали. */
const baseOf = (key: string): string => key.replace(PLURAL_SUFFIX, '');

function leafValue(bundle: object, key: string): string {
  return key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], bundle) as string;
}

const placeholdersOf = (text: string): string[] =>
  [...text.matchAll(/\{\{(\w+)\}\}/gu)].map((match) => match[1] ?? '').sort();

describe('паритет локалей (B-41, U2)', () => {
  const ruKeys = leafKeys(resources.ru.common);
  const enKeys = leafKeys(resources.en.common);

  it('набор локалей — словарь shared', () => {
    expect(Object.keys(resources)).toEqual([...LOCALES]);
  });

  it('базовые ключи совпадают в обе стороны', () => {
    const ruBase = new Set(ruKeys.map(baseOf));
    const enBase = new Set(enKeys.map(baseOf));
    expect([...enBase].filter((key) => !ruBase.has(key))).toEqual([]);
    expect([...ruBase].filter((key) => !enBase.has(key))).toEqual([]);
  });

  it('английские плюрали — только формы one и other, русские — one, few, many, other', () => {
    const forms = (keys: string[]): string[] =>
      [...new Set(keys.map((key) => PLURAL_SUFFIX.exec(key)?.[0] ?? ''))].filter(Boolean).sort();
    expect(forms(enKeys)).toEqual(['_one', '_other']);
    expect(forms(ruKeys)).toEqual(['_few', '_many', '_one', '_other']);
  });

  it('у каждой пары строк одинаковые подстановки, пустых строк нет', () => {
    const ruByBase = new Map<string, string[]>();
    for (const key of ruKeys) {
      ruByBase.set(baseOf(key), [...(ruByBase.get(baseOf(key)) ?? []), key]);
    }
    for (const enKey of enKeys) {
      const enText = leafValue(resources.en.common, enKey);
      expect(enText.trim(), enKey).not.toBe('');
      const ruKey = ruByBase.get(baseOf(enKey))?.[0];
      expect(ruKey, enKey).toBeDefined();
      const ruPlaceholders = placeholdersOf(leafValue(resources.ru.common, ruKey ?? ''));
      expect(placeholdersOf(enText), enKey).toEqual(ruPlaceholders);
    }
  });

  it.each([
    [1, '1 document'],
    [2, '2 documents'],
    [0, '0 documents'],
    [21, '21 documents'],
    [1.5, '1.5 documents'],
  ])('английские плюрали: %s → %s', (count, expected) => {
    expect(i18n.getFixedT('en')('inspector.docsCount', { count })).toBe(expected);
  });

  it('английский суффикс там, где русская строка без форм, не ломает русскую', () => {
    expect(i18n.getFixedT('en')('editor.doc.count', { count: 1 })).toBe('1 page');
    expect(i18n.getFixedT('en')('editor.doc.count', { count: 3 })).toBe('3 pages');
    expect(i18n.getFixedT('ru')('editor.doc.count', { count: 3 })).toBe('3 стр.');
  });
});

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

  it('инициализирован синхронно русской локалью — jsdom-тесты идут на русском (B-41)', () => {
    expect(i18n.isInitialized).toBe(true);
    expect(DEFAULT_LOCALE).toBe('ru');
    expect(i18n.language).toBe(DEFAULT_LOCALE);
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
