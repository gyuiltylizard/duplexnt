import { describe, expect, it } from 'vitest';
import { EMPTY_EDITS, type BacksDecision } from '@shared';
import {
  addedSetsOfJournal,
  JOURNAL_VERSION,
  newJournal,
  nextKindOf,
  parseJournal,
  pendingPairOf,
  type Journal,
  type JournalPass,
} from './journal';
import { serializeVersioned } from './versioned-file';

// Журнал версии 7 (M4.5; амендмент ADR 0004 от 2026-10-23): роли пары добавленного набора,
// ссылка пары и решение по оборотам набора; «набор ждёт обороты» — выводимое. Общая форма
// журнала и чтение версий 1–5 — в `journal.test.ts` (правило размера тестового файла).

const SESSION = 'a1b2c3d4e5f60718';

/** Проход `number` из `pageCount` страниц одним завершённым сегментом; роль — лицевые. */
const passAt = (
  number: number,
  pageCount: number,
  extra: Partial<JournalPass> = {},
): JournalPass => ({
  number,
  accepted: false,
  origin: null,
  nextSegment: 2,
  segments: [{ number: 1, state: 'completed', pageCount }],
  kind: 'fronts',
  after: null,
  pair: null,
  backsDecision: null,
  rotate180: false,
  ...extra,
});

/** Прерванный последний сегмент из `pageCount` страниц. */
const interrupted = (pageCount: number): Partial<JournalPass> => ({
  segments: [{ number: 1, state: 'interrupted', pageCount }],
});

/** Лица двустороннего набора: якорь и решение по оборотам. */
const setFronts = (
  number: number,
  pageCount: number,
  decision: BacksDecision = 'none',
  extra: Partial<JournalPass> = {},
): JournalPass =>
  passAt(number, pageCount, {
    kind: 'addedFronts',
    after: 'p01-s01-0002',
    backsDecision: decision,
    ...extra,
  });

/** Обороты набора со ссылкой на проход лиц `pair`. */
const setBacks = (
  number: number,
  pair: number,
  pageCount: number,
  extra: Partial<JournalPass> = {},
): JournalPass => passAt(number, pageCount, { kind: 'addedBacks', pair, ...extra });

const journalOf = (passes: readonly JournalPass[], extra: Partial<Journal> = {}): Journal => ({
  version: JOURNAL_VERSION,
  sessionId: SESSION,
  nextPass: Math.max(0, ...passes.map((pass) => pass.number)) + 1,
  passes: [...passes],
  deletions: [],
  backsDeclined: false,
  saved: false,
  edits: EMPTY_EDITS,
  assembled: null,
  blankMode: 'keep',
  ...extra,
});

function omit<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const dropped: readonly string[] = keys as readonly string[];
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !dropped.includes(key)),
  ) as Omit<T, K>;
}

const MAIN: readonly JournalPass[] = [passAt(1, 2), passAt(2, 2, { kind: 'backs' })];
/** Основная пачка и двусторонний набор «Д1» с оборотами. */
const PAIR = journalOf([...MAIN, setFronts(3, 2), setBacks(4, 3, 2)]);

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const parse = (value: unknown) => parseJournal(encode(value));
const withPasses = (passes: readonly JournalPass[]) => parse(journalOf(passes));
const SCHEMA = { kind: 'unreadable', reason: 'schema' };
const UNKNOWN_FIELD = { kind: 'incompatible', reason: 'unknownField' };

describe('журнал v7: роли пары и решение по оборотам набора (M4.5; амендмент ADR 0004 от 2026-10-23)', () => {
  it('пара набора записывается и читается дословно', () => {
    expect(parse(PAIR)).toEqual({ kind: 'ok', value: PAIR });
    expect(parseJournal(serializeVersioned(PAIR))).toEqual({ kind: 'ok', value: PAIR });
  });

  it('односторонний набор — по-прежнему `added`: без ссылки пары и решения', () => {
    const journal = journalOf([...MAIN, passAt(3, 1, { kind: 'added', after: 'p01-s01-0001' })]);

    expect(parse(journal)).toEqual({ kind: 'ok', value: journal });
  });

  it('поля согласованы с ролью: ссылка — только у оборотов набора, решение — только у лиц набора, якорь — у наборов', () => {
    // Обороты набора без ссылки пары.
    expect(withPasses([...MAIN, setFronts(3, 2), setBacks(4, 3, 2, { pair: null })])).toEqual(
      SCHEMA,
    );
    // Ссылка пары у оборотов основной пачки.
    expect(withPasses([passAt(1, 2), passAt(2, 2, { kind: 'backs', pair: 1 })])).toEqual(SCHEMA);
    // Решение у одностороннего набора и у лицевых основной пачки.
    expect(withPasses([...MAIN, passAt(3, 1, { kind: 'added', backsDecision: 'none' })])).toEqual(
      SCHEMA,
    );
    expect(withPasses([passAt(1, 2, { backsDecision: 'kept' })])).toEqual(SCHEMA);
    // Лица набора без решения.
    expect(withPasses([...MAIN, setFronts(3, 2, 'none', { backsDecision: null })])).toEqual(SCHEMA);
    // Якорь у оборотов набора: блок встаёт по якорю лиц.
    expect(
      withPasses([...MAIN, setFronts(3, 2), setBacks(4, 3, 2, { after: 'p01-s01-0001' })]),
    ).toEqual(SCHEMA);
  });

  it('решение — одно из трёх; ссылка пары — номер прохода', () => {
    const decision = (value: unknown) =>
      parse(journalOf([...MAIN, { ...setFronts(3, 2), backsDecision: value as BacksDecision }]));
    const pair = (value: unknown) =>
      parse(journalOf([...MAIN, setFronts(3, 2), { ...setBacks(4, 3, 2), pair: value as number }]));

    expect(decision('declined')).toMatchObject({ kind: 'ok' });
    expect(decision('maybe')).toEqual(SCHEMA);
    expect(decision(true)).toEqual(SCHEMA);
    expect(pair('три')).toEqual(SCHEMA);
    expect(pair(0)).toEqual(SCHEMA);
    expect(pair(1.5)).toEqual(SCHEMA);
  });

  it('оборотов набора со страницами на одни лица — не больше одного; пустой проход роли не занимает', () => {
    expect(withPasses([...MAIN, setFronts(3, 2), setBacks(4, 3, 2), setBacks(5, 3, 2)])).toEqual(
      SCHEMA,
    );
    // Обороты набора прерваны до первой страницы, повторный запуск получил следующий номер.
    const retried = journalOf([
      ...MAIN,
      setFronts(3, 2),
      setBacks(4, 3, 0, interrupted(0)),
      setBacks(5, 3, 2),
    ]);
    expect(parse(retried)).toEqual({ kind: 'ok', value: retried });
  });

  it('ссылка пары ведёт к лицам набора; на отсутствующий проход — осиротевшие обороты, читаются', () => {
    expect(withPasses([...MAIN, setBacks(3, 1, 2)])).toEqual(SCHEMA);
    expect(withPasses([...MAIN, passAt(3, 1, { kind: 'added' }), setBacks(4, 3, 2)])).toEqual(
      SCHEMA,
    );
    // Проход 3 отброшен (журнал пересобран): обороты остаются, их ставит сборка.
    const orphan = journalOf([...MAIN, setBacks(4, 3, 2)]);
    expect(parse(orphan)).toEqual({ kind: 'ok', value: orphan });
  });

  it('в журнале нет выводимого: «набор ждёт обороты» схемой не принимается', () => {
    expect(
      parse({ ...PAIR, passes: [...MAIN, { ...setFronts(3, 2), pendingBacks: true }] }),
    ).toEqual(UNKNOWN_FIELD);
    expect(parse({ ...PAIR, pendingSet: 1 })).toEqual(UNKNOWN_FIELD);
  });

  it('новый журнал — текущей версии', () => {
    expect(newJournal(SESSION).version).toBe(7);
  });
});

describe('журнал v7: чтение v6 (M4.5, R21)', () => {
  const v6Of = (passes: readonly JournalPass[]) => ({
    ...journalOf(passes),
    version: 6,
    passes: passes.map((pass) => omit(pass, 'pair', 'backsDecision')),
  });

  it('журнал v6 читается: ссылки пары и решения нет, добавленный набор остаётся односторонним; версия в памяти — текущая', () => {
    const passes = [...MAIN, passAt(3, 1, { kind: 'added', after: 'p01-s01-0001' })];

    expect(parse(v6Of(passes))).toEqual({ kind: 'ok', value: journalOf(passes) });
  });

  it('журнал v6 с полями пары или ролями пары — ошибка схемы: они есть только в v7', () => {
    const v6 = v6Of(MAIN);

    expect(parse({ ...v6, passes: [v6.passes[0], { ...v6.passes[1], pair: null }] })).toEqual(
      SCHEMA,
    );
    expect(parse(v6Of([...MAIN, setFronts(3, 2)]))).toEqual(SCHEMA);
  });
});

describe('журнал v7: выводимое — набор ждёт обороты и очередь ролей (M4.5, R11; KTD2)', () => {
  it('лица набора завершены, решение «ждём», оборотов нет → очередь даёт обороты набора с номером «ДN» и ожидаемым числом', () => {
    const journal = journalOf([...MAIN, setFronts(3, 2)]);

    expect(pendingPairOf(journal)).toEqual({ set: 1, fronts: 3, expected: 2 });
    expect(nextKindOf(journal)).toBe('addedBacks');
  });

  it('принятые лица набора тоже ждут; прерванные — нет: их досканируют', () => {
    const accepted = journalOf([
      ...MAIN,
      setFronts(3, 2, 'none', { ...interrupted(2), accepted: true }),
    ]);
    const pending = journalOf([...MAIN, setFronts(3, 2, 'none', interrupted(2))]);

    expect(pendingPairOf(accepted)).toEqual({ set: 1, fronts: 3, expected: 2 });
    expect(pendingPairOf(pending)).toBeNull();
    expect(nextKindOf(pending)).toBe('added');
  });

  it('обороты набора со страницами, отказ или «оставить как есть» снимают ожидание → очередь даёт добавленный набор', () => {
    expect(pendingPairOf(PAIR)).toBeNull();
    expect(nextKindOf(PAIR)).toBe('added');
    expect(nextKindOf(journalOf([...MAIN, setFronts(3, 2, 'declined')]))).toBe('added');
    expect(nextKindOf(journalOf([...MAIN, setFronts(3, 2, 'kept')]))).toBe('added');
  });

  it('пустой прерванный проход оборотов набора роли не занимает: набор ждёт дальше', () => {
    const journal = journalOf([...MAIN, setFronts(3, 2), setBacks(4, 3, 0, interrupted(0))]);

    expect(pendingPairOf(journal)).toEqual({ set: 1, fronts: 3, expected: 2 });
    expect(nextKindOf(journal)).toBe('addedBacks');
  });

  it('очередь основной пачки раньше пары: без оборотов и без отказа — обороты', () => {
    expect(nextKindOf(journalOf([passAt(1, 2), setFronts(3, 2)]))).toBe('backs');
    expect(nextKindOf(journalOf([passAt(1, 2), setFronts(3, 2)], { backsDeclined: true }))).toBe(
      'addedBacks',
    );
  });

  it('номер «ДN» — по порядку номера прохода лиц среди всех добавленных наборов; пара — один номер', () => {
    const journal = journalOf([
      ...MAIN,
      passAt(3, 1, { kind: 'added' }),
      setFronts(4, 2, 'kept'),
      setBacks(5, 4, 1),
      setFronts(6, 3),
    ]);

    expect(addedSetsOfJournal(journal)).toEqual([
      { set: 1, fronts: 3, backs: null, decision: null, sides: 'one' },
      { set: 2, fronts: 4, backs: 5, decision: 'kept', sides: 'two' },
      { set: 3, fronts: 6, backs: null, decision: 'none', sides: 'two' },
    ]);
    expect(pendingPairOf(journal)).toEqual({ set: 3, fronts: 6, expected: 3 });
  });

  it('осиротевшие обороты набора в наборы не входят и ожидания не создают', () => {
    const journal = journalOf([...MAIN, setBacks(4, 3, 2)]);

    expect(addedSetsOfJournal(journal)).toEqual([]);
    expect(pendingPairOf(journal)).toBeNull();
    expect(nextKindOf(journal)).toBe('added');
  });
});
