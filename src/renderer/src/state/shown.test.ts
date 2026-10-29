import { NO_STRAIGHTEN_MARK, type AssembledPage, type BlankFlag } from '@shared';
import { describe, expect, it } from 'vitest';
import {
  gluedBacksOf,
  movingOf,
  relocate,
  removingOf,
  sheetDrop,
  sheetOf,
  shownDocumentsOf,
  shownOf,
} from './shown';

// Показанная лента (план M4, U6; handoff M4, S1, S3, Behaviour): фильтр скрытых, скрытые
// хвосты, переезд текущей и документы в координатах показанной ленты.

const page = (key: string, blank: BlankFlag = null): AssembledPage => ({
  key,
  side: key.endsWith('o') ? 'back' : 'front',
  sheet: null,
  angle: 0,
  lost: false,
  addedSet: null,
  blank,
  straighten: NO_STRAIGHTEN_MARK,
});

// Лист 1 с скрытым оборотом, лист 2 с двумя скрытыми подряд (перенос), лист 3 с помеченным,
// лист 4 без оборота; в конце — скрытый хвост у последней страницы.
const ORDER: readonly AssembledPage[] = [
  page('1l'),
  page('1o', 'hidden'),
  page('2l'),
  page('2o', 'hidden'),
  page('2x', 'hidden'),
  page('3l'),
  page('3o', 'marked'),
  page('4l'),
  page('4o', 'hidden'),
];
const KEYS = ORDER.map((entry) => entry.key);

describe('показанная лента', () => {
  it('без переключателя скрытые выпадают, помеченные остаются; с переключателем — полная', () => {
    expect(shownOf(ORDER, false).map((entry) => entry.key)).toEqual(['1l', '2l', '3l', '3o', '4l']);
    expect(shownOf(ORDER, true)).toBe(ORDER);
  });

  const SHOWN = shownOf(ORDER, false).map((entry) => entry.key);

  it.each([
    ['показанная остаётся', '2l', '2l'],
    ['скрытая — ближайшая показанная справа', '1o', '2l'],
    ['скрытая в конце — слева', '4o', '4l'],
    ['скрытая среди скрытых — первая показанная справа', '2o', '3l'],
  ])('переезд текущей: %s', (_name, current, expected) => {
    expect(relocate(current, SHOWN, KEYS)).toBe(expected);
  });

  it('переезд: ключа нет в ленте или показанных нет — null', () => {
    expect(relocate('zz', SHOWN, KEYS)).toBeNull();
    expect(relocate('1o', [], KEYS)).toBeNull();
  });

  it('документы в координатах показанной ленты: номер в полной не меняется', () => {
    const documents = [
      { name: 'А', start: 0, count: 2 },
      { name: '', start: 2, count: 3 },
      { name: 'Б', start: 5, count: 4 },
    ];
    expect(shownDocumentsOf(documents, ORDER, shownOf(ORDER, false))).toEqual([
      { index: 0, name: 'А', start: 0, count: 1 },
      { index: 1, name: '', start: 1, count: 1 },
      { index: 2, name: 'Б', start: 2, count: 3 },
    ]);
  });

  it('документ из одних скрытых — count 0 на месте, где стоял бы', () => {
    const documents = [
      { name: '', start: 0, count: 1 },
      { name: '', start: 1, count: 1 },
      { name: '', start: 2, count: 7 },
    ];
    expect(shownDocumentsOf(documents, ORDER, shownOf(ORDER, false))).toEqual([
      { index: 0, name: '', start: 0, count: 1 },
      { index: 1, name: '', start: 1, count: 0 },
      { index: 2, name: '', start: 1, count: 4 },
    ]);
  });

  it('с переключателем документы совпадают с полной лентой', () => {
    const documents = [{ name: '', start: 0, count: 9 }];
    expect(shownDocumentsOf(documents, ORDER, ORDER)).toEqual([
      { index: 0, name: '', start: 0, count: 9 },
    ]);
  });
});

// Склеенные обороты (B-13, KTD-1, KTD-3, R6): пара + соседство, частичное выделение, цель броска.
const NONE = new Set<number>();

const paired = (
  key: string,
  sheet: number | null,
  blank: BlankFlag = null,
  addedSet: number | null = null,
): AssembledPage => ({ ...page(key, blank), sheet, addedSet });

// Основная пачка 1–2 с пустыми оборотами, лишний оборот без листа, набор Д1 из листа 1,
// лист 3 с непустым оборотом, оборот листа 4, стоящий за чужим лицом 5.
const PAIRS: readonly AssembledPage[] = [
  paired('1l', 1),
  paired('1o', 1, 'hidden'),
  paired('2l', 2),
  paired('2o', 2, 'marked'),
  paired('xo', null, 'hidden'),
  paired('d1l', 1, null, 1),
  paired('d1o', 1, 'hidden', 1),
  paired('3l', 3),
  paired('3o', 3),
  paired('5l', 5),
  paired('4o', 4, 'hidden'),
];
const PAIR_KEYS = PAIRS.map((entry) => entry.key);

describe('склеенные обороты', () => {
  it('режим пар: скрытый и помеченный оборот за своим лицом склеены, лишний без листа — цепочкой', () => {
    expect([...gluedBacksOf(PAIRS, NONE, 'pairs')]).toEqual([
      ['1o', '1l'],
      ['2o', '2l'],
      ['xo', '2l'],
      ['d1o', 'd1l'],
    ]);
  });

  it('режим пар: оборот с чужим листом за лицом не склеен; непустой оборот не склеен', () => {
    const glued = gluedBacksOf(PAIRS, NONE, 'pairs');
    expect(glued.has('4o')).toBe(false);
    expect(glued.has('3o')).toBe(false);
  });

  it('набор и основная пачка не смешиваются: лист 1 набора — не лист 1 пачки', () => {
    const order = [paired('1l', 1), paired('d1o', 1, 'hidden', 1)];
    expect(gluedBacksOf(order, NONE, 'pairs').size).toBe(0);
  });

  it('оборот с известным листом не клеится к лицу без листа (лист одностороннего набора)', () => {
    const order = [paired('1l', 1), paired('d1', null, null, 1), paired('1o', 1, 'hidden')];
    expect(gluedBacksOf(order, NONE, 'pairs').size).toBe(0);
  });

  it('граница документа между лицом и оборотом обрывает склейку', () => {
    expect(gluedBacksOf(PAIRS, new Set([1]), 'pairs').has('1o')).toBe(false);
    expect(gluedBacksOf(PAIRS, new Set([1]), 'pairs').get('2o')).toBe('2l');
  });

  it('потерянная страница не склеена: у неё нет флага пустого', () => {
    const order = [paired('1l', 1), { ...paired('1o', 1), lost: true }];
    expect(gluedBacksOf(order, NONE, 'pairs').size).toBe(0);
  });

  it('режим «собрано»: только соседство — чужой лист и позиционная сторона не мешают', () => {
    const order = [
      paired('1l', 1),
      { ...paired('4o', 4, 'hidden'), side: 'front' as const },
      paired('2l', 2),
    ];
    expect([...gluedBacksOf(order, NONE, 'assembled')]).toEqual([['4o', '1l']]);
  });

  it('режим раздельных наборов: склейки нет', () => {
    expect(gluedBacksOf(PAIRS, NONE, 'sets').size).toBe(0);
  });

  it('подблок несовпавшего набора: обороты без листов — цепочкой за последним лицом', () => {
    const order = [
      paired('a', null, null, 1),
      paired('b', null, null, 1),
      paired('c', null, null, 1),
      paired('o1', null, 'hidden', 1),
      paired('o2', null, 'hidden', 1),
    ];
    expect([...gluedBacksOf(order, NONE, 'pairs')]).toEqual([
      ['o1', 'c'],
      ['o2', 'c'],
    ]);
  });

  const GLUED = gluedBacksOf(PAIRS, NONE, 'pairs');

  it('лист: лицо с оборотами в порядке ленты — и от лица, и от оборота; чужой ключ — пусто', () => {
    expect(sheetOf('2l', GLUED, PAIR_KEYS)).toEqual(['2l', '2o', 'xo']);
    expect(sheetOf('xo', GLUED, PAIR_KEYS)).toEqual(['2l', '2o', 'xo']);
    expect(sheetOf('3l', GLUED, PAIR_KEYS)).toEqual(['3l']);
    expect(sheetOf('zz', GLUED, PAIR_KEYS)).toEqual([]);
  });

  it.each([
    ['лицо добирает оборот', ['1l'], ['1l', '1o']],
    ['оборот без лица выпадает', ['1o'], []],
    ['лицо с оборотом — без дублей', ['1o', '1l'], ['1l', '1o']],
    ['чужой оборот выпадает, своё лицо добирает', ['1l', 'd1o'], ['1l', '1o']],
    ['несклеенный оборот — обычная страница', ['3o', '4o'], ['3o', '4o']],
  ])('перенос и группировка: %s', (_name, keys, expected) => {
    expect(movingOf(keys, GLUED, PAIR_KEYS)).toEqual(expected);
  });

  it.each([
    ['лицо уводит обороты', ['2l'], ['2l', '2o', 'xo']],
    ['оборот один — удаляется сам', ['1o'], ['1o']],
    ['оборот и чужое лицо — буквально плюс его оборот', ['d1l', '1o'], ['1o', 'd1l', 'd1o']],
  ])('удаление: %s', (_name, keys, expected) => {
    expect(removingOf(keys, GLUED, PAIR_KEYS)).toEqual(expected);
  });

  it('цель броска: на склеенный оборот слева — перед лицом, справа — после листа', () => {
    expect(sheetDrop('2o', 'before', ['3l'], GLUED, PAIR_KEYS)).toEqual({
      key: '2l',
      side: 'before',
    });
    expect(sheetDrop('2o', 'after', ['3l'], GLUED, PAIR_KEYS)).toEqual({
      key: 'xo',
      side: 'after',
    });
    expect(sheetDrop('2l', 'after', ['3l'], GLUED, PAIR_KEYS)).toEqual({
      key: 'xo',
      side: 'after',
    });
    expect(sheetDrop('3l', 'before', ['1l'], GLUED, PAIR_KEYS)).toEqual({
      key: '3l',
      side: 'before',
    });
  });

  it('цель броска внутри листа перетаскиваемого — ничего', () => {
    expect(sheetDrop('2o', 'before', ['2l', '2o', 'xo'], GLUED, PAIR_KEYS)).toBeNull();
    expect(sheetDrop('2l', 'after', ['2l', '2o', 'xo'], GLUED, PAIR_KEYS)).toBeNull();
  });

  it('переезд текущей: скрытый оборот уходит на своё лицо, а не на следующую страницу', () => {
    const shown = shownOf(PAIRS, false).map((entry) => entry.key);
    expect(relocate('1o', shown, PAIR_KEYS, GLUED)).toBe('1l');
    // Без карты склейки — прежнее правило: справа.
    expect(relocate('1o', shown, PAIR_KEYS)).toBe('2l');
    // Лицо тоже скрыто (нет среди показанных) — прежнее правило.
    expect(relocate('1o', ['2l', '3l'], PAIR_KEYS, GLUED)).toBe('2l');
  });
});
