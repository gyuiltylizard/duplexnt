import { describe, expect, it } from 'vitest';
import { addedSetsOf, passesByKind, type PassKind, type PassSnapshot } from './snapshot';

// Роли проходов и нумерация добавленных наборов «ДN» (M3.5, KTD-4; M4.5, KTD2) — одно правило
// для журнала, снимка и renderer: роль из `kind`, только у прохода со страницами.

const passOf = (
  number: number,
  kind: PassKind,
  pages: number,
  extra: Partial<PassSnapshot> = {},
): PassSnapshot => ({
  number,
  kind,
  after: null,
  pair: null,
  backsDecision: null,
  state: 'completed',
  paramsKnown: true,
  scanner: null,
  rotate180: false,
  pages: Array.from({ length: pages }, (_value, index) => ({
    key: `p0${number}-s01-${String(index + 1).padStart(4, '0')}`,
    number: index + 1,
    lost: false,
  })),
  ...extra,
});

const hasPages = (pass: PassSnapshot): boolean => pass.pages.length > 0;

const MAIN = [passOf(1, 'fronts', 3), passOf(2, 'backs', 3)];
const setFronts = (number: number, pages: number, extra: Partial<PassSnapshot> = {}) =>
  passOf(number, 'addedFronts', pages, { after: 'p01-s01-0002', backsDecision: 'none', ...extra });
const setBacks = (number: number, pair: number, pages: number) =>
  passOf(number, 'addedBacks', pages, { pair });

describe('проходы по ролям: роли пары (M4.5)', () => {
  it('лица и обороты наборов — отдельными списками по возрастанию номера, только со страницами', () => {
    const roles = passesByKind(
      [...MAIN, setFronts(3, 2), setBacks(4, 3, 0), setBacks(5, 3, 2), passOf(6, 'added', 1)],
      hasPages,
    );

    expect(roles.fronts?.number).toBe(1);
    expect(roles.backs?.number).toBe(2);
    expect(roles.added.map((pass) => pass.number)).toEqual([6]);
    expect(roles.addedFronts.map((pass) => pass.number)).toEqual([3]);
    expect(roles.addedBacks.map((pass) => pass.number)).toEqual([5]);
  });
});

describe('добавленные наборы «ДN» (M4.5, KTD2)', () => {
  it('нумеруются по номеру прохода лиц среди односторонних и двусторонних; пара — один номер', () => {
    const sets = addedSetsOf(
      [
        ...MAIN,
        passOf(3, 'added', 1),
        setFronts(4, 2, { backsDecision: 'kept' }),
        setBacks(5, 4, 1),
        setFronts(6, 3),
      ],
      hasPages,
    );

    expect(sets).toEqual([
      { set: 1, fronts: 3, backs: null, decision: null, sides: 'one' },
      { set: 2, fronts: 4, backs: 5, decision: 'kept', sides: 'two' },
      { set: 3, fronts: 6, backs: null, decision: 'none', sides: 'two' },
    ]);
  });

  it('проход оборотов набора без страниц оборотами не считается; пустые лица набора номера не получают', () => {
    const sets = addedSetsOf(
      [...MAIN, setFronts(3, 2), setBacks(4, 3, 0), setFronts(5, 0)],
      hasPages,
    );

    expect(sets).toEqual([{ set: 1, fronts: 3, backs: null, decision: 'none', sides: 'two' }]);
  });

  it('обороты со ссылкой на проход, которого среди лиц со страницами нет, — осиротевшие: в наборы не входят', () => {
    expect(addedSetsOf([...MAIN, setBacks(4, 3, 2)], hasPages)).toEqual([]);
    // Лица набора отброшены до первой страницы, обороты остались: тоже осиротевшие.
    expect(addedSetsOf([...MAIN, setFronts(3, 0), setBacks(4, 3, 2)], hasPages)).toEqual([]);
  });

  it('без добавленных проходов наборов нет', () => {
    expect(addedSetsOf(MAIN, hasPages)).toEqual([]);
    expect(addedSetsOf([], hasPages)).toEqual([]);
  });
});
