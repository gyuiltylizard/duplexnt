import type { AssemblyReport } from '@shared';
import { describe, expect, it } from 'vitest';
import {
  assemblyLanded,
  assemblyOutcome,
  mismatchDue,
  pairLanded,
  setMismatchDue,
} from './assembly-outcome';
import type { AddedSetReport } from '@shared';

function report(overrides: Partial<AssemblyReport>): AssemblyReport {
  return {
    mode: 'pairs',
    groups: null,
    sets: [],
    pendingSet: null,
    fronts: 3,
    backs: 3,
    backsState: 'completed',
    backsDeclined: false,
    mismatch: false,
    ...overrides,
  };
}

/** Режим раздельных наборов с числами проходов (M3.6): группы — по счётчикам ядра. */
const sets = (fronts: number, backs: number, extra: Partial<AssemblyReport> = {}): AssemblyReport =>
  report({
    mode: 'sets',
    groups: { fronts, backs, divider: fronts },
    sets: [],
    pendingSet: null,
    fronts,
    backs,
    mismatch: true,
    ...extra,
  });

describe('assemblyOutcome (M3.6, KTD7: по режиму)', () => {
  it.each([
    ['равные проходы', report({}), 'ok'],
    ['собрано', report({ mode: 'assembled' }), 'ok'],
    ['обороты не нужны', report({ backs: 0, backsState: null, backsDeclined: true }), 'frontsOnly'],
    ['принят коротким', sets(3, 1, { backsState: 'accepted' }), 'accepted'],
    ['принят длинным — всё равно accepted', sets(3, 5, { backsState: 'accepted' }), 'accepted'],
    ['наборы: оборотов меньше', sets(3, 2), 'fewer'],
    ['наборы: оборотов больше', sets(3, 4), 'extra'],
    // Живые счётчики групп исход не меняют: числа — по проходам, в модалке они же.
    [
      'наборы уравнены добавлением — исход по проходам',
      sets(3, 2, { groups: { fronts: 3, backs: 3, divider: 3 } }),
      'fewer',
    ],
  ] as const)('%s → %s', (_name, given, expected) => {
    expect(assemblyOutcome(given)).toBe(expected);
  });
});

describe('assemblyLanded (пауза merge, KTD-5)', () => {
  it.each([
    ['проход оборотов завершён', {}, true],
    ['обороты не нужны', { backs: 0, backsState: null, backsDeclined: true }, true],
    ['обрыв оборотов', { backsState: 'interrupted', mismatch: true }, false],
    ['принят как есть — merge не повторяется', { backsState: 'accepted' }, false],
    ['только лицевые', { backs: 0, backsState: null }, false],
  ] as const)('%s → %s', (_name, overrides, expected) => {
    expect(assemblyLanded(report(overrides))).toBe(expected);
  });
});

describe('mismatchDue (модалка mismatch, KTD-8; M3.6, R20)', () => {
  it.each([
    ['совпало — не показывается', report({}), false],
    ['наборы, проход завершён', sets(3, 2), true],
    ['наборы, принят коротким', sets(3, 1, { backsState: 'accepted' }), true],
    [
      'наборы, прерван и не принят — решает плашка, не модалка',
      sets(3, 1, { backsState: 'interrupted' }),
      false,
    ],
    ['собрано — модалки нет', report({ mode: 'assembled' }), false],
    ['пары — модалки нет и при пометке', report({ mismatch: true }), false],
  ] as const)('%s → %s', (_name, given, expected) => {
    expect(mismatchDue(given)).toBe(expected);
  });
});

// — M4.5 (KTD7): посадка пары и модалка несовпадения набора —

const setReport = (overrides: Partial<AddedSetReport>): AddedSetReport => ({
  set: 1,
  fronts: 3,
  backs: 3,
  backsState: 'completed',
  decision: 'none',
  mismatch: false,
  sides: 'two',
  ...overrides,
});

describe('pairLanded (пауза merge по набору, R9)', () => {
  it.each([
    ['обороты набора завершены', {}, true],
    [
      'обороты набора приняты',
      { backs: 2, backsState: 'accepted', decision: 'kept', mismatch: true },
      true,
    ],
    ['обороты не нужны', { backs: 0, backsState: null, decision: 'declined' }, true],
    ['набор ждёт обороты', { backs: 0, backsState: null }, false],
    ['обороты идут', { backs: 1, backsState: 'running' }, false],
    ['обороты прерваны — плашка', { backs: 2, backsState: 'interrupted', mismatch: true }, false],
    ['односторонний набор', { backs: 0, backsState: null, decision: null, sides: 'one' }, false],
  ] as const)('%s → %s', (_name, overrides, expected) => {
    expect(pairLanded(setReport(overrides))).toBe(expected);
  });
});

describe('setMismatchDue (модалка набора, R15)', () => {
  it.each([
    ['не сошлось, решения нет', { backs: 2, mismatch: true }, true],
    ['сошлось', {}, false],
    ['решение kept', { backs: 2, mismatch: true, decision: 'kept' }, false],
    [
      'приняты плашкой — kept ставит ядро',
      { backs: 2, mismatch: true, backsState: 'accepted', decision: 'kept' },
      false,
    ],
    [
      'прерваны и не приняты — решает плашка',
      { backs: 2, mismatch: true, backsState: 'interrupted' },
      false,
    ],
    ['односторонний', { backs: 0, backsState: null, decision: null, sides: 'one' }, false],
  ] as const)('%s → %s', (_name, overrides, expected) => {
    const set = setReport(overrides);
    expect(
      setMismatchDue(
        report({
          sets: [
            setReport({ set: 2, sides: 'one', backs: 0, backsState: null, decision: null }),
            set,
          ],
        }),
      ),
    ).toBe(expected ? set : null);
  });

  it('без наборов — null', () => {
    expect(setMismatchDue(report({}))).toBeNull();
  });
});
