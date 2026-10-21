import type { AssemblyReport, PassSnapshot } from '@shared';
import { describe, expect, it } from 'vitest';
import { assemblyLanded, assemblyOutcome, mismatchDue } from './assembly-outcome';

function report(overrides: Partial<AssemblyReport>): AssemblyReport {
  return {
    mode: 'pairs',
    groups: null,
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

/** Добавленный проход с `count` страницами (M3.5): со страницами — ответ человека на несовпадение. */
function added(count: number): PassSnapshot {
  return {
    number: 3,
    kind: 'added',
    after: null,
    state: 'completed',
    paramsKnown: true,
    scanner: null,
    rotate180: false,
    pages: Array.from({ length: count }, (_, index) => ({
      key: `p03-s01-000${String(index + 1)}`,
      number: index + 1,
      lost: false,
    })),
  };
}

describe('mismatchDue (модалка mismatch, KTD-8; подсказка про «+ Добавить», KTD-7 M3.5)', () => {
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
    expect(mismatchDue(report(overrides), [])).toBe(expected);
  });

  const fewer = report({ backs: 2, pairs: 2, unpairedSheets: [1], mismatch: true });

  it('добавленный набор со страницами снимает несовпадение: добавление — ответ человека', () => {
    expect(mismatchDue(fewer, [added(1)])).toBe(false);
  });

  it('пустой добавленный проход (прерван до первой страницы) ничего не снимает', () => {
    expect(mismatchDue(fewer, [added(0)])).toBe(true);
  });
});
