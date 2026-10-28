import { EMPTY_EDITS, type SessionEdits } from '@shared';
import { describe, expect, it } from 'vitest';
import {
  deleted,
  dividerAfterMove,
  grouped,
  keptOriginal,
  markedNotBlank,
  moved,
  movedAcross,
  renamed,
  rotated,
  withCut,
  withoutCut,
} from './edits';

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

  it.each([
    ['без поворота → 270°', {}, ['a'], { a: 270 }],
    ['270° → 180°', { a: 270 }, ['a'], { a: 180 }],
    ['90° → запись снята', { a: 90 }, ['a'], {}],
    ['группа — каждая на −90°', { b: 90 }, ['a', 'b'], { a: 270 }],
  ] as const)('против часовой (M3.5, KTD-11): %s', (_name, rotations, keys, expected) => {
    expect(rotated(edits({ rotations }), keys, 'ccw').rotations).toEqual(expected);
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

  it('явная граница наборов сдвигается на удалённые левее неё, как разрез (M3.6, ревью #3)', () => {
    // a b c | d e, граница 3.
    expect(deleted(edits({ divider: 3 }), TAPE, ['a']).divider).toBe(2);
    expect(deleted(edits({ divider: 3 }), TAPE, ['a', 'b']).divider).toBe(1);
    expect(deleted(edits({ divider: 3 }), TAPE, ['d']).divider).toBe(3);
    expect(deleted(edits({ divider: null }), TAPE, ['a']).divider).toBeNull();
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
});

describe('жесты: граница наборов (M3.6, KTD8)', () => {
  // Лента a b c | d e: граница 3 — «a», «b», «c» лица, «d», «e» обороты.
  const DIVIDER = 3;

  it.each([
    ['лицо к обороту — в обороты: −1', ['a'], 4, 2],
    ['оборот к лицу — в лица: +1', ['e'], 0, 4],
    ['внутри группы лиц — без изменений', ['a'], 2, 3],
    ['внутри группы оборотов — без изменений', ['e'], 3, 3],
    ['двое из лиц через границу: −2', ['a', 'c'], 4, 1],
    ['смешанное выделение к лицу — все в лица: 3 − 1 + 2', ['b', 'd'], 0, 4],
    ['смешанное выделение к обороту — все в обороты: 3 − 1', ['b', 'd'], 4, 2],
    ['невидимые ключи не считаются', ['a', 'zzz'], 4, 2],
  ] as const)('%s', (_name, keys, target, expected) => {
    expect(dividerAfterMove(TAPE, DIVIDER, keys, target)).toBe(expected);
  });

  it.each([
    [
      'первый оборот — в конец лиц: порядок тот же, граница +1',
      ['d'],
      'fronts',
      ['a', 'b', 'c', 'd', 'e'],
      4,
    ],
    [
      'последнее лицо — в начало оборотов: порядок тот же, граница −1',
      ['c'],
      'backs',
      ['a', 'b', 'c', 'd', 'e'],
      2,
    ],
    [
      'лицо не у границы — в начало оборотов: сначала к границе, затем граница',
      ['a'],
      'backs',
      ['b', 'c', 'a', 'd', 'e'],
      2,
    ],
    ['оборот не у границы — в конец лиц', ['e'], 'fronts', ['a', 'b', 'c', 'e', 'd'], 4],
    [
      'смешанное выделение — целиком к границе, в порядке ленты, группа по стороне',
      ['a', 'e'],
      'backs',
      ['b', 'c', 'a', 'e', 'd'],
      2,
    ],
    ['все лица — в обороты: граница 0', ['a', 'b', 'c'], 'backs', ['a', 'b', 'c', 'd', 'e'], 0],
  ] as const)('movedAcross: %s', (_name, keys, side, order, divider) => {
    expect(movedAcross(EMPTY_EDITS, TAPE, DIVIDER, keys, side)).toEqual({
      ...EMPTY_EDITS,
      order,
      divider,
    });
  });

  it('movedAcross: без изменений порядка и границы — null; пустое выделение — null', () => {
    expect(movedAcross(EMPTY_EDITS, TAPE, DIVIDER, ['c'], 'fronts')).toBeNull();
    expect(movedAcross(EMPTY_EDITS, TAPE, DIVIDER, ['d'], 'backs')).toBeNull();
    expect(movedAcross(EMPTY_EDITS, TAPE, DIVIDER, ['zzz'], 'backs')).toBeNull();
  });

  it('movedAcross: пустая группа — в неё целиком (граница 0 или длина ленты)', () => {
    // Все обороты: граница 0 — «a» в лица.
    expect(movedAcross(EMPTY_EDITS, TAPE, 0, ['a'], 'fronts')).toEqual({
      ...EMPTY_EDITS,
      order: ['a', 'b', 'c', 'd', 'e'],
      divider: 1,
    });
    // Все лица: граница 5 — «b» в обороты, встаёт в конец.
    expect(movedAcross(EMPTY_EDITS, TAPE, 5, ['b'], 'backs')).toEqual({
      ...EMPTY_EDITS,
      order: ['a', 'c', 'd', 'e', 'b'],
      divider: 4,
    });
  });
});

// M4 (KTD5; handoff M4, S9): пометка «это не пустая страница» — ключ в `notBlank`.
describe('пометка «не пустая» (M4)', () => {
  it('добавляет ключ в notBlank, остальное не трогает', () => {
    const base = { ...EMPTY_EDITS, deleted: ['x'] };
    expect(markedNotBlank(base, 'b')).toEqual({ ...base, notBlank: ['b'] });
    expect(markedNotBlank({ ...base, notBlank: ['a'] }, 'b').notBlank).toEqual(['a', 'b']);
  });

  it('уже помеченная — без изменений (шага нет)', () => {
    const base = { ...EMPTY_EDITS, notBlank: ['b'] };
    expect(markedNotBlank(base, 'b')).toBe(base);
  });
});

describe('«Выделить в документ» — извлечение в конец ленты (M4, KTD7; B-14)', () => {
  const SIX = ['a', 'b', 'c', 'd', 'e', 'f'];

  it.each([
    [
      'подряд из середины — кусок в конец, исходный документ остаётся одним, граница перед куском',
      edits({}),
      ['b', 'c'],
      ['a', 'd', 'e', 'f', 'b', 'c'],
      [4],
      ['', ''],
      1,
    ],
    [
      'не подряд — в конец ленточным порядком',
      edits({}),
      ['b', 'e'],
      ['a', 'c', 'd', 'f', 'b', 'e'],
      [4],
      ['', ''],
      1,
    ],
    [
      'ключи не в порядке ленты — порядок куска всё равно ленточный',
      edits({}),
      ['e', 'b'],
      ['a', 'c', 'd', 'f', 'b', 'e'],
      [4],
      ['', ''],
      1,
    ],
    [
      'с хвостом (AE10): соседние ключи едут вместе, взаимный порядок прежний',
      edits({}),
      ['b', 'c', 'e'],
      ['a', 'd', 'f', 'b', 'c', 'e'],
      [3],
      ['', ''],
      1,
    ],
    [
      'разрез правее куска сдвигается на изъятые — документы соседей те же, новый за ними',
      edits({ cuts: [4], names: ['А', 'Б'] }),
      ['b', 'c'],
      ['a', 'd', 'e', 'f', 'b', 'c'],
      [2, 4],
      ['А', 'Б', ''],
      2,
    ],
    [
      'страницы из двух документов — оба остаются с именами, кусок — третьим без имени',
      edits({ cuts: [3], names: ['А', 'Б'] }),
      ['b', 'e'],
      ['a', 'c', 'd', 'f', 'b', 'e'],
      [2, 4],
      ['А', 'Б', ''],
      2,
    ],
    [
      'разрез внутри куска из середины — снят, имена соседей на местах',
      edits({ cuts: [2], names: ['А', 'Б'] }),
      ['b', 'c'],
      ['a', 'd', 'e', 'f', 'b', 'c'],
      [1, 4],
      ['А', 'Б', ''],
      2,
    ],
    [
      'документ посреди ленты целиком — переезжает в конец со своим именем, соседи те же',
      edits({ cuts: [2, 4], names: ['А', 'Б', 'В'] }),
      ['c', 'd'],
      ['a', 'b', 'e', 'f', 'c', 'd'],
      [2, 4],
      ['А', 'В', 'Б'],
      2,
    ],
    [
      'документ целиком плюс страница соседа — имя не наследуется',
      edits({ cuts: [2, 4], names: ['А', 'Б', 'В'] }),
      ['c', 'd', 'e'],
      ['a', 'b', 'f', 'c', 'd', 'e'],
      [2, 3],
      ['А', 'В', ''],
      2,
    ],
    [
      'с первой страницы — имя первого документа остаётся у его оставшихся страниц',
      edits({ cuts: [2], names: ['А', 'Б'] }),
      ['a', 'c'],
      ['b', 'd', 'e', 'f', 'a', 'c'],
      [1, 4],
      ['А', 'Б', ''],
      2,
    ],
    [
      'первый документ целиком — переезжает в конец со своим именем, второй становится первым',
      edits({ cuts: [2], names: ['А', 'Б'] }),
      ['a', 'b'],
      ['c', 'd', 'e', 'f', 'a', 'b'],
      [4],
      ['Б', 'А'],
      1,
    ],
    [
      'конец документа посреди ленты — обе границы на месте, новый за последним',
      edits({ cuts: [1, 4], names: ['А', 'Б', 'В'] }),
      ['c', 'd'],
      ['a', 'b', 'e', 'f', 'c', 'd'],
      [1, 2, 4],
      ['А', 'Б', 'В', ''],
      3,
    ],
  ] as const)('%s', (_name, given, keys, order, cuts, names, document) => {
    const result = grouped(given, SIX, keys);
    expect(result).toEqual({ edits: { ...given, order, cuts, names }, document });
    // Исходные документы целы: оставшиеся страницы разбиты на документы как прежде.
    const before = documentsOf(SIX, given.cuts);
    const after = documentsOf(order, cuts);
    const moved = new Set<string>(keys);
    const stayed = SIX.filter((key) => !moved.has(key));
    for (const left of stayed) {
      for (const right of stayed) {
        expect(after[left] === after[right]).toBe(before[left] === before[right]);
      }
    }
  });

  it('кусок уже в конце ленты — порядок не становится явным, только граница перед ним', () => {
    expect(grouped(edits({}), SIX, ['e', 'f'])).toEqual({
      edits: edits({ cuts: [4], names: ['', ''] }),
      document: 1,
    });
    const explicit = edits({ order: [...SIX] });
    expect(grouped(explicit, SIX, ['d', 'e', 'f'])?.edits.order).toBe(explicit.order);
  });

  it('кусок уже отдельный документ в конце — жеста нет, имя не трогается', () => {
    expect(grouped(edits({ cuts: [4], names: ['А', 'Б'] }), SIX, ['e', 'f'])).toBeNull();
  });

  it('ключей в ленте нет или выделена вся лента — жеста нет', () => {
    expect(grouped(edits({}), SIX, ['x'])).toBeNull();
    expect(grouped(edits({}), SIX, [])).toBeNull();
    expect(grouped(edits({}), SIX, SIX)).toBeNull();
    expect(grouped(edits({ cuts: [2], names: ['А', 'Б'] }), SIX, [...SIX].reverse())).toBeNull();
  });
});

// M6 (R14): «Вернуть оригинал» — ключ в `keepOriginal`, как пометка «не пустая».
describe('откат выравнивания (M6)', () => {
  it('добавляет ключ в keepOriginal, остальное не трогает', () => {
    const base = { ...EMPTY_EDITS, deleted: ['x'] };
    expect(keptOriginal(base, 'b')).toEqual({ ...base, keepOriginal: ['b'] });
    expect(keptOriginal({ ...base, keepOriginal: ['a'] }, 'b').keepOriginal).toEqual(['a', 'b']);
  });

  it('уже откаченная — без изменений (шага нет)', () => {
    const base = { ...EMPTY_EDITS, keepOriginal: ['b'] };
    expect(keptOriginal(base, 'b')).toBe(base);
  });
});
