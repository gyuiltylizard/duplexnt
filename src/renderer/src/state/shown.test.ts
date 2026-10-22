import type { AssembledPage, BlankFlag } from '@shared';
import { describe, expect, it } from 'vitest';
import { relocate, shownDocumentsOf, shownOf, withHiddenTails } from './shown';

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

  it.each([
    ['хвост из одного скрытого', ['1l'], ['1l', '1o']],
    ['хвост из нескольких скрытых подряд', ['2l'], ['2l', '2o', '2x']],
    ['помеченная — не хвост', ['3l'], ['3l']],
    ['хвост у последней страницы', ['4l'], ['4l', '4o']],
    ['скрытая сама по себе — без хвоста соседей', ['1o'], ['1o']],
    [
      'несколько ключей — в порядке полной ленты с хвостами',
      ['4l', '1l'],
      ['1l', '1o', '4l', '4o'],
    ],
    ['чужой ключ отбрасывается', ['zz'], []],
  ])('хвосты: %s', (_name, keys, expected) => {
    expect(withHiddenTails(keys, ORDER)).toEqual(expected);
  });

  it('хвост не тянется через показанную страницу', () => {
    // 3o помечена и показана: скрытый 4o — хвост 4l, не 3l.
    expect(withHiddenTails(['3l', '3o'], ORDER)).toEqual(['3l', '3o']);
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
