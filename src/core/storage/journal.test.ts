import { describe, expect, it } from 'vitest';
import {
  JOURNAL_VERSION,
  pagesOf,
  parseJournal,
  passStateOf,
  type Journal,
  type JournalPass,
} from './journal';
import { parsePageFileName, parsePageKey, pageKey, segmentPrefix } from './layout';
import { isSetAsideName, serializeVersioned } from './versioned-file';

const PASS: JournalPass = {
  number: 1,
  accepted: false,
  origin: {
    scanner: {
      scheme: 'https',
      host: 'scanner.test',
      port: 443,
      basePath: '/eSCL',
      fingerprint: 'ab'.repeat(32),
      uuid: '00000000-0000-4000-8000-000000000001',
      name: 'Test Scanner',
    },
    params: { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' },
    pixelLimit: 5100 * 8400,
  },
  nextSegment: 4,
  segments: [
    { number: 1, state: 'interrupted', pageCount: 17 },
    { number: 3, state: 'completed', pageCount: 13 },
  ],
};

const JOURNAL: Journal = {
  version: JOURNAL_VERSION,
  sessionId: 'a1b2c3d4e5f60718',
  nextPass: 2,
  passes: [PASS],
  deletions: ['p01-s02-'],
};

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const parse = (value: unknown) => parseJournal(encode(value));

describe('журнал: запись и чтение', () => {
  it('запись и чтение дают равные структуры', () => {
    expect(parseJournal(serializeVersioned(JOURNAL))).toEqual({ kind: 'ok', value: JOURNAL });
  });

  it('пересобранный проход без сканера и параметров читается', () => {
    const rebuilt = { ...JOURNAL, passes: [{ ...PASS, origin: null }] };

    expect(parse(rebuilt)).toEqual({ kind: 'ok', value: rebuilt });
  });
});

describe('журнал: версия (KTD-35)', () => {
  it('маркер версии новее понятного — несовместимость, что бы ни лежало рядом', () => {
    expect(parse({ ...JOURNAL, version: 2 })).toEqual({
      kind: 'incompatible',
      reason: 'newerVersion',
    });
    expect(parse({ version: 7, совсем: 'другая форма' })).toEqual({
      kind: 'incompatible',
      reason: 'newerVersion',
    });
  });

  it('неизвестное поле при текущей версии — несовместимость, на любой глубине', () => {
    const unknownField = { kind: 'incompatible', reason: 'unknownField' };

    expect(parse({ ...JOURNAL, rotation: {} })).toEqual(unknownField);
    expect(parse({ ...JOURNAL, passes: [{ ...PASS, label: 'лицевые' }] })).toEqual(unknownField);
    expect(
      parse({
        ...JOURNAL,
        passes: [{ ...PASS, segments: [{ number: 1, state: 'completed', pageCount: 1, x: 1 }] }],
      }),
    ).toEqual(unknownField);
  });

  it('неизвестное поле вместе с ошибкой типа в другом поле — всё равно несовместимость', () => {
    expect(parse({ ...JOURNAL, nextPass: 'два', rotation: {} })).toEqual({
      kind: 'incompatible',
      reason: 'unknownField',
    });
  });
});

describe('журнал: нечитаемый (KTD-34)', () => {
  it('пустой файл', () => {
    expect(parseJournal(new Uint8Array(0))).toEqual({ kind: 'unreadable', reason: 'empty' });
  });

  it('не JSON и не UTF-8', () => {
    const notJson = { kind: 'unreadable', reason: 'notJson' };

    expect(parseJournal(new TextEncoder().encode('{ "version": 1, "sess'))).toEqual(notJson);
    expect(parseJournal(Uint8Array.of(0xff, 0xfe, 0x7b, 0x7d))).toEqual(notJson);
  });

  it('не проходит схему текущей версии', () => {
    const schema = { kind: 'unreadable', reason: 'schema' };

    expect(parse([])).toEqual(schema);
    expect(parse('строка')).toEqual(schema);
    expect(parse({ ...JOURNAL, version: undefined })).toEqual(schema);
    expect(parse({ ...JOURNAL, version: 0 })).toEqual(schema);
    expect(parse({ ...JOURNAL, nextPass: 'два' })).toEqual(schema);
    expect(parse({ ...JOURNAL, sessionId: '../../etc' })).toEqual(schema);
    expect(parse({ ...JOURNAL, deletions: ['p01-'] })).toEqual(schema);
    expect(parse({ ...JOURNAL, passes: [{ ...PASS, segments: [] }] })).toEqual(schema);
  });

  it('номера, которые нарушают счётчики, — тоже ошибка схемы', () => {
    const schema = { kind: 'unreadable', reason: 'schema' };

    // Номер сегмента не меньше счётчика: следующий сегмент лёг бы на занятый префикс.
    expect(parse({ ...JOURNAL, passes: [{ ...PASS, nextSegment: 3 }] })).toEqual(schema);
    expect(parse({ ...JOURNAL, nextPass: 1 })).toEqual(schema);
    // Номера не по возрастанию.
    expect(
      parse({ ...JOURNAL, passes: [{ ...PASS, segments: [...PASS.segments].reverse() }] }),
    ).toEqual(schema);
    expect(parse({ ...JOURNAL, nextPass: 3, passes: [PASS, PASS] })).toEqual(schema);
  });

  it('имя элемента `__proto__` в журнале ничего не подменяет', () => {
    const text = JSON.stringify(JOURNAL).replace('"deletions"', '"__proto__":{"x":1},"deletions"');

    expect(parseJournal(new TextEncoder().encode(text))).toEqual({
      kind: 'incompatible',
      reason: 'unknownField',
    });
    expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain('x');
  });
});

describe('журнал: выводимое', () => {
  it('состояние прохода — состояние последнего сегмента и признак «принят»', () => {
    const withLast = (state: 'running' | 'completed' | 'interrupted', accepted = false) =>
      passStateOf({ ...PASS, accepted, segments: [{ number: 1, state, pageCount: 1 }] });

    expect(withLast('running')).toBe('running');
    expect(withLast('completed')).toBe('completed');
    expect(withLast('interrupted')).toBe('interrupted');
    expect(withLast('interrupted', true)).toBe('accepted');
  });

  it('номер страницы в проходе — порядок получения через все сегменты', () => {
    const pages = pagesOf(PASS);

    expect(pages).toHaveLength(30);
    expect(pages[16]).toMatchObject({ key: 'p01-s01-0017', number: 17 });
    expect(pages[17]).toMatchObject({ key: 'p01-s03-0001', number: 18 });
    expect(pages[29]).toMatchObject({ key: 'p01-s03-0013', number: 30 });
  });
});

describe('раскладка: ключ страницы', () => {
  it('ключ собирается и разбирается обратно', () => {
    const address = { pass: 1, segment: 2, index: 17 };

    expect(pageKey(address)).toBe('p01-s02-0017');
    expect(parsePageKey('p01-s02-0017')).toEqual(address);
    expect(parsePageFileName('p01-s02-0017.jpg')).toEqual(address);
  });

  it('префикс `p01-s01-` не совпадает с ключами сегмента 11', () => {
    expect(pageKey({ pass: 1, segment: 11, index: 1 }).startsWith(segmentPrefix(1, 1))).toBe(false);
  });

  it('всё, что не ключ по заякоренному шаблону, отклоняется', () => {
    for (const key of [
      '',
      'p01-s01-0001.jpg',
      'p1-s1-1',
      'p01-s01-0001/..',
      '../p01-s01-0001',
      'p01-s01-00011',
      ' p01-s01-0001',
      'p00-s01-0001',
      'p01-s00-0001',
      'p01-s01-0000',
    ]) {
      expect(parsePageKey(key)).toBeNull();
    }
    expect(parsePageFileName('p01-s01-0001.jpg.0123456789ab.tmp')).toBeNull();
    expect(parsePageFileName('p01-s01-0001.JPG')).toBeNull();
  });

  it('отодвинутая копия узнаётся только по своему шаблону', () => {
    expect(isSetAsideName('session.json.unreadable-0123456789ab', 'session.json')).toBe(true);
    expect(isSetAsideName('session.json', 'session.json')).toBe(false);
    expect(isSetAsideName('session.json.bak', 'session.json')).toBe(false);
    expect(isSetAsideName('other.json.unreadable-0123456789ab', 'session.json')).toBe(false);
  });
});
