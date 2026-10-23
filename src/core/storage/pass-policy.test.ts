import { describe, expect, it } from 'vitest';
import { EMPTY_EDITS, ok as okOf, type AddedPassIntent, type BacksDecision } from '@shared';
import { ORIGIN } from '../../../test/support/session-store';
import { JOURNAL_VERSION, type Journal, type JournalPass } from './journal';
import { locatePass, planPass, resumable, type PolicyState } from './pass-policy';

// Политика запуска — чистые запросы над журналом (M3.5, KTD-5; M4.5, R11, KTD2). Сценарии через
// хранилище с файлами — в `session-store.flags.test.ts` (очередь M2–M3.5) и
// `session-store.pairs.test.ts` (пара набора).

const passAt = (
  number: number,
  pageCount: number,
  extra: Partial<JournalPass> = {},
): JournalPass => ({
  number,
  accepted: false,
  origin: ORIGIN,
  nextSegment: 2,
  segments: [{ number: 1, state: 'completed', pageCount }],
  kind: 'fronts',
  after: null,
  pair: null,
  backsDecision: null,
  rotate180: false,
  ...extra,
});

const interrupted = (pageCount: number): Partial<JournalPass> => ({
  segments: [{ number: 1, state: 'interrupted', pageCount }],
});

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

const setBacks = (
  number: number,
  pair: number,
  pageCount: number,
  extra: Partial<JournalPass> = {},
): JournalPass => passAt(number, pageCount, { kind: 'addedBacks', pair, ...extra });

const journalOf = (passes: readonly JournalPass[], extra: Partial<Journal> = {}): Journal => ({
  version: JOURNAL_VERSION,
  sessionId: 'a1b2c3d4e5f60718',
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

const state = (journal: Journal | null, incompatible = false): PolicyState => ({
  journal,
  incompatible,
});
const conflict = (reason: string) => ({
  ok: false,
  error: { code: 'sessionConflict', details: { reason } },
});

const MAIN: readonly JournalPass[] = [passAt(1, 2), passAt(2, 2, { kind: 'backs' })];
const TWO_SIDED: AddedPassIntent = { kind: 'addedFronts', after: 'p01-s01-0002' };
const ONE_SIDED: AddedPassIntent = { kind: 'added', after: null };

describe('политика запуска: пара добавленного набора (M4.5, R11; KTD2)', () => {
  it('набор ждёт обороты: без намерения — его обороты с ожидаемым числом и ссылкой пары', () => {
    const expected = okOf({ kind: 'addedBacks', resumed: false, expected: 2, pair: 3 });

    expect(planPass(state(journalOf([...MAIN, setFronts(3, 2)])), null)).toEqual(expected);
    // Принятые лица набора ждут так же.
    expect(
      planPass(
        state(journalOf([...MAIN, setFronts(3, 2, 'none', { ...interrupted(2), accepted: true })])),
        null,
      ),
    ).toEqual(expected);
  });

  it('прерванные обороты набора — досканирование того же прохода с «из F»; прерванные лица набора — без ожидаемого', () => {
    expect(
      planPass(
        state(journalOf([...MAIN, setFronts(3, 3), setBacks(4, 3, 1, interrupted(1))])),
        null,
      ),
    ).toEqual(okOf({ kind: 'addedBacks', resumed: true, expected: 3, pair: 3 }));
    expect(
      planPass(state(journalOf([...MAIN, setFronts(3, 2, 'none', interrupted(2))])), null),
    ).toEqual(okOf({ kind: 'addedFronts', resumed: true, expected: null, pair: null }));
  });

  it('после отказа от оборотов набора или «оставить как есть» — очередь M2: backsPresent / backsDeclined', () => {
    expect(planPass(state(journalOf([...MAIN, setFronts(3, 2, 'declined')])), null)).toEqual(
      conflict('backsPresent'),
    );
    expect(
      planPass(
        state(journalOf([passAt(1, 2), setFronts(3, 2, 'kept')], { backsDeclined: true })),
        null,
      ),
    ).toEqual(conflict('backsDeclined'));
  });

  it('с намерением: лица двустороннего набора — как односторонний; якорь не из сессии — invalidInput; без сессии — noSession', () => {
    expect(planPass(state(journalOf(MAIN)), TWO_SIDED)).toEqual(
      okOf({ kind: 'addedFronts', resumed: false, expected: null, pair: null }),
    );
    expect(planPass(state(journalOf(MAIN)), { ...TWO_SIDED, after: 'p09-s01-0001' })).toEqual({
      ok: false,
      error: { code: 'invalidInput', details: { field: 'after' } },
    });
    expect(planPass(state(null), TWO_SIDED)).toEqual(conflict('noSession'));
    expect(planPass(state(journalOf([])), TWO_SIDED)).toEqual(conflict('noSession'));
  });

  it('пока набор ждёт обороты, новый набор не начинается — pairPending при любом намерении', () => {
    const pending = state(journalOf([...MAIN, setFronts(3, 2)]));

    expect(planPass(pending, TWO_SIDED)).toEqual(conflict('pairPending'));
    expect(planPass(pending, ONE_SIDED)).toEqual(conflict('pairPending'));
  });

  it('двусторонний набор в режиме раздельных наборов — pairInSets; односторонний проходит; после сборки — проходит (R3)', () => {
    const sets = journalOf([passAt(1, 3), passAt(2, 2, { kind: 'backs' })]);

    expect(planPass(state(sets), TWO_SIDED)).toEqual(conflict('pairInSets'));
    expect(planPass(state(sets), ONE_SIDED)).toMatchObject({ ok: true, value: { kind: 'added' } });
    expect(
      planPass(state({ ...sets, assembled: ['p01-s01-0001', 'p02-s01-0002'] }), TWO_SIDED),
    ).toMatchObject({ ok: true, value: { kind: 'addedFronts' } });
  });

  it('при прерванном последнем проходе намерение — passInterrupted, как у одностороннего', () => {
    const journal = journalOf([...MAIN, passAt(3, 1, { kind: 'added', ...interrupted(1) })]);

    expect(planPass(state(journal), TWO_SIDED)).toEqual(conflict('passInterrupted'));
  });

  it('режим отказа — storageIncompatible для плана и досканирования (KTD-35)', () => {
    const refused = { ok: false, error: { code: 'storageIncompatible' } };

    expect(planPass(state(journalOf(MAIN), true), null)).toEqual(refused);
    expect(resumable(state(journalOf(MAIN), true))).toEqual(refused);
  });

  it('проход по ключу страницы: запись есть — проход; номер за pageCount, чужой сегмент или не ключ — null', () => {
    const journal = journalOf(MAIN);

    expect(locatePass(journal, 'p02-s01-0002')?.number).toBe(2);
    expect(locatePass(journal, 'p02-s01-0003')).toBeNull();
    expect(locatePass(journal, 'p02-s02-0001')).toBeNull();
    expect(locatePass(journal, 'лист 2')).toBeNull();
    expect(locatePass(null, 'p01-s01-0001')).toBeNull();
  });
});
