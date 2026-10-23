import type { PassSnapshot } from '@shared';
import { describe, expect, it, vi } from 'vitest';
import { i18n } from '../i18n';
import { rotateRowOf, rotateTargetOf, rotateTargetText } from './useRotateTarget';

// Цель тумблера 180° по пачке текущей страницы (план M4.5, U7; R16; KTD4; handoff M4.5, S9).

const t = i18n.t.bind(i18n);

const pass = (number: number, kind: PassSnapshot['kind'], extra: Partial<PassSnapshot> = {}) =>
  ({
    number,
    kind,
    state: 'completed',
    paramsKnown: true,
    scanner: null,
    after: null,
    pair: null,
    backsDecision: null,
    rotate180: false,
    pages: [{ key: `p${String(number)}`, number: 1, lost: false }],
    ...extra,
  }) satisfies PassSnapshot;

const FRONTS = pass(1, 'fronts');
const BACKS = pass(2, 'backs');
const SET_FRONTS = pass(3, 'addedFronts', { after: 'p1', backsDecision: 'none' });
const SET_BACKS = pass(4, 'addedBacks', { pair: 3 });
const ONE_SIDED = pass(5, 'added');

describe('rotateTargetOf', () => {
  const all = [FRONTS, BACKS, SET_FRONTS, SET_BACKS, ONE_SIDED];

  it.each([
    ['текущая на основном документе', null, { kind: 'main', pass: 2 }],
    ['ленты нет — основной документ', undefined, { kind: 'main', pass: 2 }],
    ['текущая на паре «Д1»', 1, { kind: 'set', pass: 4, set: 1 }],
    ['текущая на одностороннем «Д2» — недоступен с причиной (AE15)', 2, { kind: 'none', set: 2 }],
  ] as const)('%s', (_name, addedSet, expected) => {
    expect(rotateTargetOf(all, addedSet)).toEqual(expected);
  });

  it('оборотов нет ни у одной пачки — тумблера нет', () => {
    expect(rotateTargetOf([FRONTS], null)).toBeNull();
    expect(rotateTargetOf([FRONTS, ONE_SIDED], 1)).toBeNull();
    expect(rotateTargetOf([FRONTS, SET_FRONTS], 1)).toBeNull();
  });

  it('основной документ без оборотов, набор с оборотами — тумблер есть: основной недоступен, набор крутится', () => {
    const passes = [FRONTS, SET_FRONTS, SET_BACKS];
    expect(rotateTargetOf(passes, null)).toEqual({ kind: 'none', set: null });
    expect(rotateTargetOf(passes, 1)).toEqual({ kind: 'set', pass: 4, set: 1 });
  });

  it('пустой проход оборотов роли не занимает: прерванные до первой страницы обороты набора — нет цели', () => {
    const passes = [
      FRONTS,
      SET_FRONTS,
      pass(4, 'addedBacks', { pair: 3, state: 'interrupted', pages: [] }),
    ];
    expect(rotateTargetOf(passes, 1)).toBeNull();
  });

  it('прерванные и принятые обороты набора — цель, как у основной пачки', () => {
    const passes = [FRONTS, SET_FRONTS, pass(4, 'addedBacks', { pair: 3, state: 'accepted' })];
    expect(rotateTargetOf(passes, 1)).toEqual({ kind: 'set', pass: 4, set: 1 });
  });
});

describe('rotateTargetText / rotateRowOf', () => {
  it.each([
    [{ kind: 'main', pass: 2 }, 'обороты основного документа'],
    [{ kind: 'set', pass: 4, set: 1 }, 'обороты набора Д1'],
    [{ kind: 'none', set: null }, 'у основного документа нет оборотов'],
    [{ kind: 'none', set: 2 }, 'у набора Д2 нет оборотов'],
  ] as const)('%o → %s', (target, expected) => {
    expect(rotateTargetText(t, target)).toBe(expected);
  });

  it('строка подвала: флаг цели из карты, недоступность с причиной, блокировка записью', () => {
    const onChange = vi.fn();
    const flags = new Map([
      [2, true],
      [4, false],
    ]);
    expect(rotateRowOf(t, { kind: 'main', pass: 2 }, flags, false, onChange)).toEqual({
      checked: true,
      disabled: false,
      unavailable: false,
      target: 'обороты основного документа',
      onChange,
    });
    expect(rotateRowOf(t, { kind: 'set', pass: 4, set: 1 }, flags, true, onChange)).toMatchObject({
      checked: false,
      disabled: true,
      unavailable: false,
    });
    expect(rotateRowOf(t, { kind: 'none', set: 2 }, flags, false, onChange)).toMatchObject({
      checked: false,
      disabled: true,
      unavailable: true,
      target: 'у набора Д2 нет оборотов',
    });
    expect(rotateRowOf(t, null, flags, false, onChange)).toBeNull();
  });
});
