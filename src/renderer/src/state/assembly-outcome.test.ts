import type { AssemblyReport } from '@shared';
import { describe, expect, it } from 'vitest';
import { assemblyLanded, assemblyOutcome, mismatchDue } from './assembly-outcome';

function report(overrides: Partial<AssemblyReport>): AssemblyReport {
  return {
    mode: 'pairs',
    groups: null,
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
