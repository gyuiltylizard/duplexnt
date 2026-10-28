import { describe, expect, it } from 'vitest';
import { EMPTY_EDITS } from '@shared';
import {
  JOURNAL_VERSION,
  newJournal,
  parseJournal,
  type Journal,
  type JournalPass,
} from './journal';
import { serializeVersioned } from './versioned-file';

// Журнал версии 8 (M6; амендмент ADR 0004 от 2026-10-28): режим выравнивания на сессии и откат
// выравнивания в правках; оценки перекоса и файлы коррекции — производное, в журнал не идут.
// Общая форма журнала и чтение версий 1–6 — в `journal.test.ts`, пары наборов — в
// `journal.v7.test.ts` (правило размера тестового файла).

const SESSION = 'a1b2c3d4e5f60718';
const KEY = 'p01-s01-0002';

/** Проход `number` из `pageCount` страниц одним сегментом в состоянии `state`. */
const passAt = (
  number: number,
  pageCount: number,
  state: 'completed' | 'interrupted' | 'running' = 'completed',
  extra: Partial<JournalPass> = {},
): JournalPass => ({
  number,
  accepted: false,
  origin: null,
  nextSegment: 2,
  segments: [{ number: 1, state, pageCount }],
  kind: 'fronts',
  after: null,
  pair: null,
  backsDecision: null,
  rotate180: false,
  ...extra,
});

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
  straighten: 'off',
  ...extra,
});

function omit<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const dropped: readonly string[] = keys as readonly string[];
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !dropped.includes(key)),
  ) as Omit<T, K>;
}

/** Тот же журнал формы v7: без режима выравнивания и отката. */
const v7Of = (passes: readonly JournalPass[], extra: Partial<Journal> = {}) => {
  const current = journalOf(passes, extra);
  return { ...omit(current, 'straighten'), version: 7, edits: omit(current.edits, 'keepOriginal') };
};

const MAIN: readonly JournalPass[] = [passAt(1, 2), passAt(2, 2, 'completed', { kind: 'backs' })];

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const parse = (value: unknown) => parseJournal(encode(value));
const SCHEMA = { kind: 'unreadable', reason: 'schema' };
const UNKNOWN_FIELD = { kind: 'incompatible', reason: 'unknownField' };

describe('журнал v8: режим выравнивания и откат (M6; амендмент ADR 0004 от 2026-10-28)', () => {
  it('режим и откат записываются и читаются дословно', () => {
    const journal = journalOf(MAIN, {
      straighten: 'auto',
      edits: { ...EMPTY_EDITS, keepOriginal: [KEY] },
    });

    expect(parse(journal)).toEqual({ kind: 'ok', value: journal });
    expect(parseJournal(serializeVersioned(journal))).toEqual({ kind: 'ok', value: journal });
  });

  it('режим — одно из двух значений; откат — ключи страниц без приведения', () => {
    expect(parse(journalOf(MAIN, { straighten: 'hide' as never }))).toEqual(SCHEMA);
    expect(parse(journalOf(MAIN, { straighten: null as never }))).toEqual(SCHEMA);
    expect(parse(omit(journalOf(MAIN), 'straighten'))).toEqual(SCHEMA);
    expect(parse(journalOf(MAIN, { edits: { ...EMPTY_EDITS, keepOriginal: ['лист 2'] } }))).toEqual(
      SCHEMA,
    );
    expect(parse(journalOf(MAIN, { edits: omit(EMPTY_EDITS, 'keepOriginal') as never }))).toEqual(
      SCHEMA,
    );
  });

  it('в журнале нет производного: оценка перекоса и запись о коррекции схемой не принимаются', () => {
    expect(parse({ ...journalOf(MAIN), skew: { [KEY]: 'willStraighten' } })).toEqual(UNKNOWN_FIELD);
    expect(
      parse(journalOf(MAIN, { edits: { ...EMPTY_EDITS, straightened: [KEY] } as never })),
    ).toEqual(UNKNOWN_FIELD);
  });

  it('новый журнал начинает с режимом «не выравнивать» и без откатов', () => {
    expect(newJournal(SESSION)).toMatchObject({
      version: JOURNAL_VERSION,
      straighten: 'off',
      edits: EMPTY_EDITS,
    });
  });

  it('маркер версии новее — несовместимость', () => {
    expect(parse({ ...journalOf(MAIN), version: JOURNAL_VERSION + 1 })).toEqual({
      kind: 'incompatible',
      reason: 'newerVersion',
    });
  });
});

describe('журнал v8: чтение v7 (M6, R15)', () => {
  it('журнал v7 читается: режим «не выравнивать», откатов нет; версия в памяти — текущая', () => {
    expect(parse(v7Of(MAIN, { saved: true }))).toEqual({
      kind: 'ok',
      value: journalOf(MAIN, { saved: true }),
    });
  });

  it('журнал v7 с открытым проходом и незакрытым заданием читается так же', () => {
    const passes = [...MAIN, passAt(3, 1, 'running', { kind: 'added', after: KEY })];
    const interrupted = [...MAIN, passAt(3, 1, 'interrupted', { kind: 'added', after: KEY })];

    expect(parse(v7Of(passes))).toEqual({ kind: 'ok', value: journalOf(passes) });
    expect(parse(v7Of(interrupted))).toEqual({ kind: 'ok', value: journalOf(interrupted) });
  });

  it('правки v7 читаются дословно, откат добавляется пустым', () => {
    const edits = { ...EMPTY_EDITS, notBlank: [KEY], deleted: ['p01-s01-0001'] };

    expect(parse(v7Of(MAIN, { edits }))).toEqual({
      kind: 'ok',
      value: journalOf(MAIN, { edits: { ...edits, keepOriginal: [] } }),
    });
  });

  it('журнал v7 с режимом или откатом — ошибка схемы: они есть только в v8', () => {
    expect(parse({ ...v7Of(MAIN), straighten: 'off' })).toEqual(SCHEMA);
    expect(parse({ ...v7Of(MAIN), edits: EMPTY_EDITS })).toEqual(SCHEMA);
  });
});
