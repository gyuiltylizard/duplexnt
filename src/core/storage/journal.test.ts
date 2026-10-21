import { describe, expect, it } from 'vitest';
import { EMPTY_EDITS } from '@shared';
import {
  JOURNAL_VERSION,
  newJournal,
  nextKindOf,
  pagesOf,
  parseJournal,
  passStateOf,
  rolesOf,
  type Journal,
  type JournalPass,
} from './journal';
import { rolesOf as rolesOfPasses } from '../../../test/support/session-store';
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
  kind: 'fronts',
  after: null,
  rotate180: false,
};

const JOURNAL: Journal = {
  version: JOURNAL_VERSION,
  sessionId: 'a1b2c3d4e5f60718',
  nextPass: 2,
  passes: [PASS],
  deletions: ['p01-s02-'],
  backsDeclined: false,
  saved: false,
  edits: EMPTY_EDITS,
  assembled: null,
};

// Правки M3 во всех полях: перенос, поворот, удаление, разрез с именем второго документа.
const EDITED: Journal = {
  ...JOURNAL,
  edits: {
    order: ['p01-s03-0001', 'p01-s01-0001'],
    rotations: { 'p01-s01-0002': 90, 'p01-s03-0002': 270 },
    deleted: ['p01-s01-0003'],
    cuts: [5],
    names: ['', 'Договор'],
    divider: null,
  },
};

// Сессия M3.6: граница наборов задана переносом, затем документ собран — запись сборки есть.
const ASSEMBLED: Journal = {
  ...JOURNAL,
  edits: { ...EMPTY_EDITS, divider: 2, deleted: ['p01-s01-0003'] },
  assembled: ['p01-s01-0001', 'p01-s03-0001', 'p01-s01-0002', 'p01-s01-0003'],
};

function omit<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const dropped: readonly string[] = keys as readonly string[];
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !dropped.includes(key)),
  ) as Omit<T, K>;
}

// Проход версии 3 (M3): без роли и якоря — роль выводилась по позиции.
const V3_PASS = omit(PASS, 'kind', 'after');

/** Проход `number` из `pageCount` страниц одним завершённым сегментом. */
const passAt = (number: number, pageCount: number, extra: Partial<JournalPass> = {}) => ({
  ...PASS,
  number,
  segments: [{ number: 1, state: 'completed' as const, pageCount }],
  ...extra,
});
/** То же для журнала v3: без `kind`/`after`. */
const v3PassAt = (number: number, pageCount: number, extra: object = {}) =>
  omit({ ...passAt(number, pageCount), ...extra }, 'kind', 'after');

// Журнал версии 4 (M3.5): тот же состав без записи сборки и границы наборов.
const V4_JOURNAL = {
  ...omit(JOURNAL, 'assembled'),
  version: 4,
  edits: omit(EMPTY_EDITS, 'divider'),
};

// Журнал версии 3 (M3): тот же состав, роль прохода — по позиции.
const V3_JOURNAL = { ...V4_JOURNAL, version: 3, passes: [V3_PASS] };

// Журнал версии 2 (M2): тот же состав без правок редактора.
const V2_JOURNAL = { ...omit(V3_JOURNAL, 'edits'), version: 2 };

// Журнал версии 1 (M1): тот же состав без полей v2–v4.
const V1_JOURNAL = {
  ...omit(V3_JOURNAL, 'backsDeclined', 'saved', 'edits'),
  version: 1,
  passes: [omit(V3_PASS, 'rotate180')],
};

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const parse = (value: unknown) => parseJournal(encode(value));

describe('журнал: запись и чтение', () => {
  it('запись и чтение дают равные структуры', () => {
    expect(parseJournal(serializeVersioned(JOURNAL))).toEqual({ kind: 'ok', value: JOURNAL });
  });

  it('правки редактора записываются и читаются дословно (M3)', () => {
    expect(parseJournal(serializeVersioned(EDITED))).toEqual({ kind: 'ok', value: EDITED });
  });

  it('пересобранный проход без сканера и параметров читается', () => {
    const rebuilt = { ...JOURNAL, passes: [{ ...PASS, origin: null }] };

    expect(parse(rebuilt)).toEqual({ kind: 'ok', value: rebuilt });
  });
});

describe('журнал: чтение прежних версий (M2, R13; M3, R2; M3.5, R1; M3.6, R1)', () => {
  const v3RolesOf = (passes: object[]) => {
    const parsed = parse({ ...V3_JOURNAL, nextPass: 9, passes });
    expect(parsed.kind).toBe('ok');
    return parsed.kind === 'ok' ? rolesOfPasses(parsed.value.passes) : [];
  };

  it('журнал v4 читается: сборки нет, граница наборов авто; версия в памяти — текущая', () => {
    expect(parse(V4_JOURNAL)).toEqual({ kind: 'ok', value: JOURNAL });
  });

  it('журнал v4 с записью сборки или границей — ошибка схемы: они есть только в v5', () => {
    const schema = { kind: 'unreadable', reason: 'schema' };

    expect(parse({ ...V4_JOURNAL, assembled: null })).toEqual(schema);
    expect(parse({ ...V4_JOURNAL, edits: EMPTY_EDITS })).toEqual(schema);
  });

  it('журнал v3 читается: роль — по позиции среди проходов, якоря нет', () => {
    expect(parse(V3_JOURNAL)).toEqual({ kind: 'ok', value: JOURNAL });
    expect(v3RolesOf([v3PassAt(1, 3), v3PassAt(2, 3), v3PassAt(3, 1)])).toEqual([
      [1, 'fronts', null],
      [2, 'backs', null],
      [3, 'added', null],
    ]);
    expect(v3RolesOf([v3PassAt(1, 3)])).toEqual([[1, 'fronts', null]]);
    // Проход 2 остановлен и исчез; повторный запуск оборотов получил номер 3.
    expect(v3RolesOf([v3PassAt(1, 3), v3PassAt(3, 3)])).toEqual([
      [1, 'fronts', null],
      [3, 'backs', null],
    ]);
  });

  it('журнал v3: флаг поворота второго прохода переживает чтение на проходе оборотов', () => {
    const parsed = parse({
      ...V3_JOURNAL,
      nextPass: 3,
      passes: [v3PassAt(1, 2), v3PassAt(2, 2, { rotate180: true })],
    });

    expect(parsed.kind === 'ok' ? rolesOf(parsed.value).backs?.rotate180 : null).toBe(true);
  });

  it('журнал v3: пустой проход роли не занимает — позиция считается по проходам со страницами', () => {
    // Прерван до первой страницы (сбой между началом сегмента и первой страницей), затем
    // лицевые пошли проходом 2: он лицевой, а не обороты.
    expect(
      v3RolesOf([
        v3PassAt(1, 0, { segments: [{ number: 1, state: 'interrupted', pageCount: 0 }] }),
        v3PassAt(2, 3),
      ]),
    ).toEqual([
      [1, 'fronts', null],
      [2, 'fronts', null],
    ]);
  });

  it('журнал v2 читается: правок нет, роль по позиции, версия в памяти — текущая', () => {
    expect(parse(V2_JOURNAL)).toEqual({ kind: 'ok', value: JOURNAL });
  });

  it('журнал v1 читается цепочкой v1 → v2 → v3 → v4 → v5 с дефолтами всех новых полей', () => {
    expect(parse(V1_JOURNAL)).toEqual({ kind: 'ok', value: JOURNAL });
  });

  it('журнал v3 с ролью на проходе — ошибка схемы: роль есть только в v4', () => {
    expect(parse({ ...V3_JOURNAL, passes: [PASS] })).toEqual({
      kind: 'unreadable',
      reason: 'schema',
    });
  });

  it('неизвестное поле в журнале v2 — несовместимость, не откат к v2-чтению', () => {
    expect(parse({ ...V2_JOURNAL, rotation: {} })).toEqual({
      kind: 'incompatible',
      reason: 'unknownField',
    });
  });

  it('журнал v2 с правками — ошибка схемы: правки есть только в v3', () => {
    expect(parse({ ...V2_JOURNAL, edits: EMPTY_EDITS })).toEqual({
      kind: 'unreadable',
      reason: 'schema',
    });
  });

  it('неизвестное поле в журнале v1 — несовместимость, не откат к v1-чтению', () => {
    expect(parse({ ...V1_JOURNAL, rotation: {} })).toEqual({
      kind: 'incompatible',
      reason: 'unknownField',
    });
  });

  it('битый журнал v1 — нечитаемый, а не тихие дефолты', () => {
    expect(parse({ ...V1_JOURNAL, nextPass: 'два' })).toEqual({
      kind: 'unreadable',
      reason: 'schema',
    });
    expect(parse({ ...V1_JOURNAL, nextPass: 1 })).toEqual({ kind: 'unreadable', reason: 'schema' });
  });
});

describe('журнал: версия (KTD-35)', () => {
  it('маркер версии новее понятного — несовместимость, что бы ни лежало рядом', () => {
    expect(parse({ ...JOURNAL, version: 6 })).toEqual({
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

  it('в журнале нет выводимого: отчёт пар схемой не принимается', () => {
    // Запись сборки — решение пользователя, а не производное (амендмент 2026-10-19): она в
    // журнале есть. Числа пар и листы без оборота выводятся из проходов — их в журнале нет.
    expect(parse({ ...JOURNAL, pairs: 3 })).toEqual({
      kind: 'incompatible',
      reason: 'unknownField',
    });
  });
});

describe('журнал: запись сборки и граница наборов (M3.6; амендмент ADR 0004 от 2026-10-19)', () => {
  it('запись сборки и граница записываются и читаются дословно', () => {
    expect(parseJournal(serializeVersioned(ASSEMBLED))).toEqual({ kind: 'ok', value: ASSEMBLED });
  });

  it('граница наборов — целое от нуля или null; ноль допустим (группа без видимых страниц)', () => {
    const schema = { kind: 'unreadable', reason: 'schema' };
    const withDivider = (divider: unknown) =>
      parse({ ...JOURNAL, edits: { ...EMPTY_EDITS, divider } });

    expect(withDivider(0)).toMatchObject({ kind: 'ok' });
    expect(withDivider(30)).toMatchObject({ kind: 'ok' });
    expect(withDivider(-1)).toEqual(schema);
    expect(withDivider(1.5)).toEqual(schema);
    expect(withDivider('2')).toEqual(schema);
  });

  it('запись сборки — ключи страниц без повторов; пустая запись допустима', () => {
    const schema = { kind: 'unreadable', reason: 'schema' };
    const withAssembled = (assembled: unknown) => parse({ ...JOURNAL, assembled });

    expect(withAssembled([])).toMatchObject({ kind: 'ok' });
    expect(withAssembled(['p01-s01-0001', 'p01-s01-0001'])).toEqual(schema);
    expect(withAssembled(['лист 1'])).toEqual(schema);
    expect(withAssembled('p01-s01-0001')).toEqual(schema);
  });

  it('новый журнал начинает без записи сборки и с границей авто', () => {
    expect(newJournal('a1b2c3d4e5f60718')).toMatchObject({
      version: JOURNAL_VERSION,
      assembled: null,
      edits: EMPTY_EDITS,
    });
  });
});

describe('журнал: форма правок (M3)', () => {
  const withEdits = (edits: Record<string, unknown>) =>
    parse({ ...EDITED, edits: { ...EDITED.edits, ...edits } });
  const schema = { kind: 'unreadable', reason: 'schema' };

  it('имён ровно на одно больше, чем разрезов', () => {
    expect(withEdits({ names: ['Договор'] })).toEqual(schema);
    expect(withEdits({ cuts: [], names: [] })).toEqual(schema);
    expect(withEdits({ cuts: [], names: [''] })).toMatchObject({ kind: 'ok' });
  });

  it('разрезы — целые неотрицательные по неубыванию', () => {
    expect(withEdits({ cuts: [5, 2], names: ['', '', ''] })).toEqual(schema);
    expect(withEdits({ cuts: [-1], names: ['', ''] })).toEqual(schema);
    expect(withEdits({ cuts: [1.5], names: ['', ''] })).toEqual(schema);
    // Совпадающие разрезы — пустой документ: его схлопывает нормализация, не отказ читать.
    expect(withEdits({ cuts: [2, 2], names: ['', '', ''] })).toMatchObject({ kind: 'ok' });
  });

  it('угол — только 90, 180 или 270; ключ — только ключ страницы', () => {
    expect(withEdits({ rotations: { 'p01-s01-0001': 0 } })).toEqual(schema);
    expect(withEdits({ rotations: { 'p01-s01-0001': 45 } })).toEqual(schema);
    expect(withEdits({ rotations: { 'p01-s01-0001.jpg': 90 } })).toEqual(schema);
    expect(withEdits({ order: ['../p01-s01-0001'] })).toEqual(schema);
    expect(withEdits({ deleted: ['p01-s01-'] })).toEqual(schema);
  });

  it('имя документа длиннее предела — ошибка схемы', () => {
    expect(withEdits({ cuts: [5], names: ['', 'я'.repeat(201)] })).toEqual(schema);
  });

  it('неизвестное поле в правках — несовместимость', () => {
    expect(withEdits({ history: [] })).toEqual({ kind: 'incompatible', reason: 'unknownField' });
  });

  it('ключ `__proto__` в углах ничего не подменяет: zod его отбрасывает', () => {
    const text = JSON.stringify(EDITED).replace('"rotations":{', '"rotations":{"__proto__":90,');

    const parsed = parseJournal(new TextEncoder().encode(text));
    expect(parsed).toEqual({ kind: 'ok', value: EDITED });
    expect(Object.getPrototypeOf(parsed.kind === 'ok' ? parsed.value.edits.rotations : {})).toBe(
      Object.prototype,
    );
  });
});

describe('журнал: роль прохода и якорь (M3.5; амендмент ADR 0004 от 2026-10-07)', () => {
  const schema = { kind: 'unreadable', reason: 'schema' };
  const withPasses = (passes: JournalPass[]) => parse({ ...JOURNAL, nextPass: 9, passes });

  it('добавленный набор с якорем записывается и читается дословно', () => {
    const journal: Journal = {
      ...JOURNAL,
      nextPass: 4,
      passes: [
        passAt(1, 2),
        passAt(2, 2, { kind: 'backs' }),
        passAt(3, 1, { kind: 'added', after: 'p01-s01-0002' }),
      ],
    };

    expect(parse(journal)).toEqual({ kind: 'ok', value: journal });
    expect(parseJournal(serializeVersioned(journal))).toEqual({ kind: 'ok', value: journal });
  });

  it('якорь только у добавленного набора; `null` — в конец ленты', () => {
    expect(withPasses([passAt(1, 2, { after: 'p01-s01-0001' })])).toEqual(schema);
    expect(
      withPasses([passAt(1, 2), passAt(2, 2, { kind: 'backs', after: 'p01-s01-0001' })]),
    ).toEqual(schema);
    expect(withPasses([passAt(1, 2), passAt(2, 1, { kind: 'added', after: null })])).toMatchObject({
      kind: 'ok',
    });
  });

  it('якорь — только ключ страницы; роль — только из трёх известных', () => {
    expect(withPasses([passAt(1, 2), passAt(2, 1, { kind: 'added', after: 'p01-s01-' })])).toEqual(
      schema,
    );
    expect(parse({ ...JOURNAL, passes: [{ ...PASS, kind: 'extra' }] })).toEqual(schema);
    expect(parse({ ...JOURNAL, passes: [{ ...PASS, after: 1 }] })).toEqual(schema);
  });

  it('лицевых и оборотов со страницами — не больше одного каждого', () => {
    expect(withPasses([passAt(1, 2), passAt(2, 2)])).toEqual(schema);
    expect(
      withPasses([passAt(1, 2), passAt(2, 2, { kind: 'backs' }), passAt(3, 2, { kind: 'backs' })]),
    ).toEqual(schema);
    // Пустой проход роли не занимает: после сбоя до первой страницы повторный запуск той же
    // роли лежит рядом с пустым.
    expect(
      withPasses([
        passAt(1, 2),
        passAt(2, 0, {
          kind: 'backs',
          segments: [{ number: 1, state: 'interrupted', pageCount: 0 }],
        }),
        passAt(3, 2, { kind: 'backs' }),
      ]),
    ).toMatchObject({ kind: 'ok' });
    // Добавленных — сколько угодно.
    expect(
      withPasses([passAt(1, 2), passAt(2, 1, { kind: 'added' }), passAt(3, 1, { kind: 'added' })]),
    ).toMatchObject({ kind: 'ok' });
  });

  it('проходы по ролям: из `kind`, только со страницами; добавленные — по возрастанию номера', () => {
    const journal: Journal = {
      ...JOURNAL,
      nextPass: 6,
      passes: [
        passAt(1, 3),
        passAt(2, 0, {
          kind: 'backs',
          segments: [{ number: 1, state: 'interrupted', pageCount: 0 }],
        }),
        passAt(3, 1, { kind: 'added', after: 'p01-s01-0001' }),
        passAt(4, 0, {
          kind: 'added',
          segments: [{ number: 1, state: 'interrupted', pageCount: 0 }],
        }),
        passAt(5, 2, { kind: 'added' }),
      ],
    };

    const roles = rolesOf(journal);
    expect(roles.fronts?.number).toBe(1);
    expect(roles.backs).toBeNull();
    expect(roles.added.map((pass) => pass.number)).toEqual([3, 5]);
  });

  it('пустой проход не считается уцелевшим и роли не занимает', () => {
    const journal: Journal = {
      ...JOURNAL,
      nextPass: 3,
      passes: [
        passAt(1, 0, { segments: [{ number: 1, state: 'interrupted', pageCount: 0 }] }),
        passAt(2, 2, { kind: 'backs' }),
      ],
    };

    expect(rolesOf(journal)).toMatchObject({ fronts: null, added: [] });
    expect(rolesOf(journal).backs?.number).toBe(2);
  });

  it('роль следующего прохода по очереди: лицевые → обороты (если не отказались) → добавленный', () => {
    const empty = { ...JOURNAL, passes: [] };
    expect(nextKindOf(empty)).toBe('fronts');
    expect(nextKindOf({ ...JOURNAL, passes: [passAt(1, 2)] })).toBe('backs');
    expect(nextKindOf({ ...JOURNAL, passes: [passAt(1, 2)], backsDeclined: true })).toBe('added');
    expect(
      nextKindOf({
        ...JOURNAL,
        nextPass: 3,
        passes: [passAt(1, 2), passAt(2, 2, { kind: 'backs' })],
      }),
    ).toBe('added');
    // Пустой проход оборотов роли не занимает: очередь оборотов остаётся.
    expect(
      nextKindOf({
        ...JOURNAL,
        nextPass: 3,
        passes: [
          passAt(1, 2),
          passAt(2, 0, {
            kind: 'backs',
            segments: [{ number: 1, state: 'interrupted', pageCount: 0 }],
          }),
        ],
      }),
    ).toBe('backs');
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
