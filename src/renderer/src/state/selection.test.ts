import { describe, expect, it } from 'vitest';
import {
  NO_SELECTION,
  afterRemoval,
  collapsed,
  contiguousRange,
  pruned,
  ranged,
  selectionOf,
  single,
  targetsOf,
  toggled,
} from './selection';

// Выделение в ленте (план M3, U6; UI_SPEC §6.5): клик, Shift-диапазон, Ctrl-переключение,
// выделение после удаления и после Ctrl+Z, «только подряд» для «Выделить в документ».

const TAPE = ['a', 'b', 'c', 'd', 'e'];

describe('выделение', () => {
  it('клик — одна страница, текущая и якорь', () => {
    expect(single('c')).toEqual({ current: 'c', anchor: 'c', keys: ['c'] });
  });

  it.each([
    ['вперёд', 'b', 'd', ['b', 'c', 'd']],
    ['назад', 'd', 'a', ['a', 'b', 'c', 'd']],
    ['на сам якорь', 'c', 'c', ['c']],
  ])('Shift — диапазон %s; якорь остаётся', (_name, anchor, key, keys) => {
    expect(ranged(single(anchor), key, TAPE)).toEqual({ current: key, anchor, keys });
  });

  it('Shift после Shift — диапазон от того же якоря, а не наращивание', () => {
    const wide = ranged(single('b'), 'e', TAPE);

    expect(ranged(wide, 'c', TAPE).keys).toEqual(['b', 'c']);
  });

  it('Shift без якоря или к исчезнувшей странице — одна страница', () => {
    expect(ranged(NO_SELECTION, 'c', TAPE)).toEqual(single('c'));
    expect(ranged(single('q'), 'c', TAPE)).toEqual(single('c'));
  });

  it('Ctrl — добавить: набор в порядке ленты, добавленная — текущая и якорь', () => {
    expect(toggled(single('d'), 'b', TAPE)).toEqual({
      current: 'b',
      anchor: 'b',
      keys: ['b', 'd'],
    });
  });

  it('Ctrl — убрать текущую: текущей становится ближайшая из оставшихся', () => {
    const three = { current: 'c', anchor: 'c', keys: ['a', 'c', 'd'] };

    expect(toggled(three, 'c', TAPE)).toEqual({ current: 'd', anchor: 'd', keys: ['a', 'd'] });
  });

  it('Ctrl — последнюю убрать нельзя', () => {
    expect(toggled(single('c'), 'c', TAPE)).toEqual(single('c'));
  });

  it('«Снять» — выделение сжимается до текущей', () => {
    expect(collapsed({ current: 'c', anchor: 'a', keys: ['a', 'b', 'c'] })).toEqual(single('c'));
    expect(collapsed(NO_SELECTION)).toEqual(NO_SELECTION);
  });

  it('действие — над выделением из нескольких или над текущей', () => {
    expect(targetsOf({ current: 'c', anchor: 'a', keys: ['a', 'c'] })).toEqual(['a', 'c']);
    expect(targetsOf(single('c'))).toEqual(['c']);
    expect(targetsOf(NO_SELECTION)).toEqual([]);
  });
});

describe('выделение после изменения ленты', () => {
  it('новый снимок: пропавшие выпадают, порядок — по новой ленте', () => {
    const given = { current: 'b', anchor: 'd', keys: ['b', 'd', 'q'] };

    expect(pruned(given, ['d', 'c', 'b'])).toEqual({
      current: 'b',
      anchor: 'd',
      keys: ['d', 'b'],
    });
  });

  it('новый снимок без текущей — текущей становится первая уцелевшая выделенная', () => {
    expect(pruned({ current: 'q', anchor: 'q', keys: ['q', 'c'] }, TAPE)).toEqual(single('c'));
    expect(pruned(single('q'), TAPE)).toEqual(single('a'));
    expect(pruned(single('a'), [])).toEqual(NO_SELECTION);
  });

  it.each([
    ['из середины — встала следующая', ['b', 'c'], ['a', 'd', 'e'], 'd'],
    ['хвост — последняя оставшаяся', ['d', 'e'], ['a', 'b', 'c'], 'c'],
    ['вразброс — после первой удалённой', ['b', 'd'], ['a', 'c', 'e'], 'c'],
  ])('удаление %s', (_name, removed, after, current) => {
    expect(afterRemoval(TAPE, removed, after)).toEqual(single(current));
  });

  it('удалено всё — выделения нет', () => {
    expect(afterRemoval(TAPE, TAPE, [])).toEqual(NO_SELECTION);
  });

  it('после Ctrl+Z — затронутые видимые страницы, текущая — первая по ленте', () => {
    expect(selectionOf(['d', 'b', 'q'], TAPE)).toEqual({
      current: 'b',
      anchor: 'b',
      keys: ['b', 'd'],
    });
    // Шаг про имя или границу: страниц нет — выделение не трогать.
    expect(selectionOf([], TAPE)).toBeNull();
    expect(selectionOf(['q'], TAPE)).toBeNull();
  });
});

describe('«Выделить в документ»: только подряд', () => {
  it.each([
    ['подряд в любом порядке', ['d', 'b', 'c'], { from: 1, to: 3 }],
    ['одна страница', ['c'], { from: 2, to: 2 }],
    ['с дыркой', ['a', 'c'], null],
    ['пусто', [], null],
    ['чужие ключи не считаются', ['b', 'q', 'c'], { from: 1, to: 2 }],
  ])('%s', (_name, keys, expected) => {
    expect(contiguousRange(TAPE, keys)).toEqual(expected);
  });
});
