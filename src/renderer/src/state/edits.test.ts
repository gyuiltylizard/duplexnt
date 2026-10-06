import { EMPTY_EDITS, type SessionEdits } from '@shared';
import { describe, expect, it } from 'vitest';
import { deleted, moved, renamed, rotated, separated, withCut, withoutCut } from './edits';

// Табличные тесты жестов редактора (план M3, U6; KTD-8): здесь решается, в какой документ
// попадёт страница после переноса и удаления, — молча сменить документ соседу нельзя (AE5).
// Нормализацию (совпавшие разрезы, пустые документы) делает ядро — её тесты в
// `src/core/scan/edits.test.ts`; здесь проверяется сырой результат жеста.

const edits = (extra: Partial<SessionEdits>): SessionEdits => ({ ...EMPTY_EDITS, ...extra });

const TAPE = ['a', 'b', 'c', 'd', 'e'];

/** Номер документа каждой страницы ленты по разрезам — как их увидит ядро. */
const documentsOf = (tape: readonly string[], cuts: readonly number[]): Record<string, number> =>
  Object.fromEntries(
    tape.map((key, index) => [key, cuts.filter((cut) => cut <= index).length] as const),
  );

describe('жесты: поворот', () => {
  it.each([
    ['без поворота → 90°', {}, ['a'], { a: 90 }],
    ['90° → 180°', { a: 90 }, ['a'], { a: 180 }],
    ['270° → запись снята', { a: 270 }, ['a'], {}],
    ['группа — каждая на 90°', { b: 180 }, ['a', 'b'], { a: 90, b: 270 }],
    ['повтор ключа — поворот один раз', {}, ['a', 'a'], { a: 90 }],
  ] as const)('%s', (_name, rotations, keys, expected) => {
    expect(rotated(edits({ rotations }), keys).rotations).toEqual(expected);
  });
});

describe('жесты: удаление', () => {
  it('разрез правее удалённой сдвигается — сосед остаётся в своём документе', () => {
    // a b | c d e → удалили «a»: «b» по-прежнему в первом документе, «c» — во втором.
    const next = deleted(edits({ cuts: [2], names: ['Счёт', 'Акт'] }), TAPE, ['a']);

    expect(next.deleted).toEqual(['a']);
    expect(next.cuts).toEqual([1]);
    expect(next.names).toEqual(['Счёт', 'Акт']);
  });

  it('разрез левее удалённой не двигается', () => {
    expect(deleted(edits({ cuts: [2], names: ['', ''] }), TAPE, ['d']).cuts).toEqual([2]);
  });

  it('документ удалён целиком — разрезы совпали, схлопнет ядро (AE6)', () => {
    // a | b c | d e → удалили «b», «c».
    const next = deleted(edits({ cuts: [1, 3], names: ['А', 'Б', 'В'] }), TAPE, ['b', 'c']);

    expect(next.cuts).toEqual([1, 1]);
    expect(next.deleted).toEqual(['b', 'c']);
  });

  it('пометки копятся в порядке ленты, без повторов; невидимые ключи не помечаются', () => {
    const next = deleted(edits({ deleted: ['z'] }), TAPE, ['d', 'b', 'q']);

    expect(next.deleted).toEqual(['z', 'b', 'd']);
  });

  it('удалять нечего — те же правки', () => {
    const given = edits({ cuts: [2], names: ['', ''] });

    expect(deleted(given, TAPE, ['q'])).toBe(given);
  });
});

describe('жесты: перенос (KTD-8, AE5)', () => {
  const SPLIT = edits({ cuts: [2], names: ['Счёт', 'Акт'] }); // a b | c d e

  it.each([
    [
      'из второго документа в начало — сменил документ только перенесённый',
      ['d'],
      'a',
      'before',
      ['d', 'a', 'b', 'c', 'e'],
      [3],
      { a: 0, b: 0, c: 1, d: 0, e: 1 },
    ],
    [
      'после последней страницы документа — остаётся в нём',
      ['e'],
      'b',
      'after',
      ['a', 'b', 'e', 'c', 'd'],
      [3],
      { a: 0, b: 0, c: 1, d: 1, e: 0 },
    ],
    [
      'перед первой страницей следующего — уходит в него',
      ['a'],
      'c',
      'before',
      ['b', 'a', 'c', 'd', 'e'],
      [1],
      { a: 1, b: 0, c: 1, d: 1, e: 1 },
    ],
    [
      'внутри документа — разрез на месте',
      ['c'],
      'e',
      'after',
      ['a', 'b', 'd', 'e', 'c'],
      [2],
      { a: 0, b: 0, c: 1, d: 1, e: 1 },
    ],
    [
      'группа через разрез — внутренний порядок ленты сохранён',
      ['e', 'a'],
      'c',
      'after',
      ['b', 'c', 'a', 'e', 'd'],
      [1],
      { a: 1, b: 0, c: 1, d: 1, e: 1 },
    ],
  ] as const)('%s', (_name, keys, target, side, order, cuts, documents) => {
    const next = moved(SPLIT, TAPE, keys, target, side);

    expect(next?.order).toEqual(order);
    expect(next?.cuts).toEqual(cuts);
    expect(next?.names).toEqual(['Счёт', 'Акт']);
    expect(documentsOf(order, cuts)).toEqual(documents);
  });

  it('документ перенесён целиком — разрез ушёл к краю, схлопнет ядро (AE6)', () => {
    const next = moved(SPLIT, TAPE, ['a', 'b'], 'e', 'after');

    expect(next?.order).toEqual(['c', 'd', 'e', 'a', 'b']);
    expect(next?.cuts).toEqual([0]);
  });

  it.each([
    ['бросок на перетаскиваемую страницу', ['b', 'c'], 'c', 'before'],
    ['бросок на исходное место', ['d'], 'e', 'before'],
    ['бросок на исходное место с другой стороны', ['b'], 'a', 'after'],
    ['цель не в ленте', ['b'], 'q', 'before'],
    ['переносить нечего', ['q'], 'a', 'before'],
  ] as const)('%s — шага нет', (_name, keys, target, side) => {
    expect(moved(SPLIT, TAPE, keys, target, side)).toBeNull();
  });

  it('перенос на край документа с другой стороны разреза — не no-op: документ сменился', () => {
    // «b» — последняя в первом документе; бросок «перед c» переносит её во второй.
    const next = moved(SPLIT, TAPE, ['b'], 'c', 'before');

    expect(next?.order).toEqual(TAPE);
    expect(next?.cuts).toEqual([1]);
  });

  it('удалённые в ленте не участвуют: порядок — из видимых', () => {
    const next = moved(edits({ deleted: ['c'] }), ['a', 'b', 'd', 'e'], ['e'], 'a', 'before');

    expect(next?.order).toEqual(['e', 'a', 'b', 'd']);
    expect(next?.deleted).toEqual(['c']);
  });
});

describe('жесты: границы и имена', () => {
  it.each([
    ['в середине', edits({}), 2, [2], ['', '']],
    [
      'второй разрез левее первого — имя встаёт на своё место',
      edits({ cuts: [3], names: ['А', 'Б'] }),
      1,
      [1, 3],
      ['А', '', 'Б'],
    ],
    ['правее существующего', edits({ cuts: [1], names: ['А', 'Б'] }), 4, [1, 4], ['А', 'Б', '']],
  ] as const)('граница %s', (_name, given, position, cuts, names) => {
    expect(withCut(given, position, 5)).toEqual({ ...given, cuts, names });
  });

  it.each([
    ['перед первой страницей', 0],
    ['за концом ленты', 5],
    ['там, где уже стоит', 2],
  ])('граница %s — нельзя', (_name, position) => {
    expect(withCut(edits({ cuts: [2], names: ['', ''] }), position, 5)).toBeNull();
  });

  it('снятие границы удаляет имя документа за ней (R12)', () => {
    const given = edits({ cuts: [1, 3], names: ['А', 'Б', 'В'] });

    expect(withoutCut(given, 1)).toEqual({ ...given, cuts: [3], names: ['А', 'В'] });
    expect(withoutCut(given, 2)).toEqual({ ...given, cuts: [1], names: ['А', 'Б'] });
    expect(withoutCut(given, 0)).toBe(given);
    expect(withoutCut(given, 3)).toBe(given);
  });

  it('переименование меняет одно имя; то же имя — те же правки', () => {
    const given = edits({ cuts: [2], names: ['', 'Акт'] });

    expect(renamed(given, 0, 'Счёт').names).toEqual(['Счёт', 'Акт']);
    expect(renamed(given, 1, 'Акт')).toBe(given);
    expect(renamed(given, 2, 'Лишний')).toBe(given);
  });

  it.each([
    ['середина — две границы', edits({}), 1, 2, [1, 3], ['', '', ''], 1],
    ['от начала ленты — граница только после', edits({}), 0, 1, [2], ['', ''], 0],
    ['до конца ленты — граница только до', edits({}), 3, 4, [3], ['', ''], 1],
    [
      'одна граница уже стоит',
      edits({ cuts: [1], names: ['А', 'Б'] }),
      1,
      2,
      [1, 3],
      ['А', 'Б', ''],
      1,
    ],
    [
      'кусок уже отдельный — без изменений',
      edits({ cuts: [1, 3], names: ['А', 'Б', 'В'] }),
      1,
      2,
      [1, 3],
      ['А', 'Б', 'В'],
      1,
    ],
    [
      'внутри куска граница — снята с именем, хвост сохранил имя своего документа',
      edits({ cuts: [2], names: ['А', 'Б'] }),
      1,
      3,
      [1, 4],
      ['А', '', 'Б'],
      1,
    ],
    [
      'внутри куска две границы — обе сняты, хвост — с именем последнего документа',
      edits({ cuts: [2, 3], names: ['А', 'Б', 'В'] }),
      1,
      3,
      [1, 4],
      ['А', '', 'В'],
      1,
    ],
    [
      'внутренняя граница, кусок до конца ленты — хвоста нет, имя уходит с границей',
      edits({ cuts: [3], names: ['А', 'Б'] }),
      1,
      4,
      [1],
      ['А', ''],
      1,
    ],
    [
      'внутренняя граница, кусок от начала ленты — имя первого куску, хвосту — его прежнее',
      edits({ cuts: [1], names: ['А', 'Б'] }),
      0,
      2,
      [3],
      ['А', 'Б'],
      0,
    ],
    [
      'внутренняя граница и граница сразу за куском — хвост уже свой, имена на местах',
      edits({ cuts: [2, 4], names: ['А', 'Б', 'В'] }),
      1,
      3,
      [1, 4],
      ['А', '', 'В'],
      1,
    ],
    [
      'без внутренних границ хвост внутри документа куска — поведение прежнее',
      edits({ cuts: [1], names: ['А', 'Б'] }),
      2,
      3,
      [1, 2, 4],
      ['А', 'Б', '', ''],
      2,
    ],
  ] as const)('«Выделить в документ»: %s', (_name, given, from, to, cuts, names, document) => {
    expect(separated(given, from, to, 5)).toEqual({ edits: { ...given, cuts, names }, document });
  });
});
