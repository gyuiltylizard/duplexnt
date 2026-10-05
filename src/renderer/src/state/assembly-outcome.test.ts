import type { AssemblyReport } from '@shared';
import { describe, expect, it } from 'vitest';
import { assemblyLanded, assemblyOutcome, mismatchDue } from './assembly-outcome';

function report(overrides: Partial<AssemblyReport>): AssemblyReport {
  return {
    fronts: 3,
    backs: 3,
    pairs: 3,
    unpairedSheets: [],
    extraBacks: 0,
    backsState: 'completed',
    backsDeclined: false,
    mismatch: false,
    ...overrides,
  };
}

describe('assemblyOutcome', () => {
  it.each([
    ['равные проходы', {}, 'ok'],
    [
      'обороты не нужны',
      { backs: 0, pairs: 0, backsState: null, backsDeclined: true },
      'frontsOnly',
    ],
    [
      'принят коротким',
      { backs: 1, pairs: 1, unpairedSheets: [1, 2], backsState: 'accepted', mismatch: true },
      'accepted',
    ],
    [
      'принят длинным — всё равно accepted',
      { backs: 5, pairs: 3, extraBacks: 2, backsState: 'accepted', mismatch: true },
      'accepted',
    ],
    ['оборотов меньше', { backs: 2, pairs: 2, unpairedSheets: [1], mismatch: true }, 'fewer'],
    ['оборотов больше', { backs: 4, pairs: 3, extraBacks: 1, mismatch: true }, 'extra'],
  ] as const)('%s → %s', (_name, overrides, expected) => {
    expect(assemblyOutcome(report(overrides))).toBe(expected);
  });
});

describe('assemblyLanded (пауза merge, KTD-5)', () => {
  it.each([
    ['проход оборотов завершён', {}, true],
    ['обороты не нужны', { backs: 0, backsState: null, backsDeclined: true }, true],
    ['обрыв оборотов', { backsState: 'interrupted', mismatch: true }, false],
    ['принят как есть — merge не повторяется', { backsState: 'accepted' }, false],
    ['только лицевые', { backs: 0, pairs: 0, backsState: null }, false],
  ] as const)('%s → %s', (_name, overrides, expected) => {
    expect(assemblyLanded(report(overrides))).toBe(expected);
  });
});

describe('mismatchDue (модалка mismatch, KTD-8)', () => {
  it.each([
    ['совпало — не показывается', {}, false],
    ['завершён с недостачей', { backs: 2, pairs: 2, unpairedSheets: [1], mismatch: true }, true],
    [
      'принят коротким',
      { backs: 1, pairs: 1, unpairedSheets: [1, 2], backsState: 'accepted', mismatch: true },
      true,
    ],
    [
      'прерван и не принят — решает плашка, не модалка',
      { backs: 1, pairs: 1, unpairedSheets: [1, 2], backsState: 'interrupted', mismatch: true },
      false,
    ],
  ] as const)('%s → %s', (_name, overrides, expected) => {
    expect(mismatchDue(report(overrides))).toBe(expected);
  });
});
