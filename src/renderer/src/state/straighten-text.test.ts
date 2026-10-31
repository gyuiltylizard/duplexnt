import type { AssembledPage, StraightenMark } from '@shared';
import { describe, expect, it } from 'vitest';
import { i18n } from '../i18n';
import {
  straightActionLabel,
  straightFactText,
  straightNoteText,
  straightSelectionOf,
  straightSelectionText,
  thumbStraightLabel,
} from './straighten-text';

// Счёт выделения по статусам и подписи (M6, U8; handoff M6): подходящие для «Оставить
// оригинал» — только `straightened`, для «Выровнять» — только `kept` (AE17); `null` не считается.

const t = i18n.t.bind(i18n);

const mark = (
  status: StraightenMark['status'],
  reason: StraightenMark['reason'] = null,
  recalc: StraightenMark['recalc'] = null,
): StraightenMark => ({
  status,
  reason,
  version: status === 'straightened' || status === 'kept' ? 1 : null,
  detector: status === 'straightened' || status === 'kept' ? 1 : null,
  recalc,
});

const page = (key: string, straighten: StraightenMark): AssembledPage => ({
  key,
  side: 'front',
  sheet: null,
  angle: 0,
  lost: false,
  addedSet: null,
  blank: null,
  straighten,
});

const PAGES = [
  page('a', mark('straightened')),
  page('b', mark('kept')),
  page('c', mark('unmeasurable', 'measure')),
  page('d', mark('deferred', 'fail')),
  page('e', mark('pending')),
  page('f', mark('level')),
  page('g', mark(null)),
  page('h', mark('straightened')),
];

describe('выделение по статусам выравнивания', () => {
  it('считает статусы в порядке ленты; подходящие — по статусу; null не входит', () => {
    const selection = straightSelectionOf(PAGES, ['h', 'a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(selection).toEqual({
      count: 8,
      straightened: 2,
      kept: 1,
      undone: 2,
      pending: 1,
      level: 1,
      keep: ['a', 'h'],
      restore: ['b'],
    });
    expect(straightSelectionText(t, selection)).toBe(
      'Из 8 выделенных: выровнено 2, оригинал по вашему выбору — 1, не выровнено 2, в обработке 1, ровных 1.',
    );
  });

  it('пустое выделение и выделение из одних null — «выравнивание не применялось»', () => {
    expect(straightSelectionOf(PAGES, [])).toMatchObject({ count: 0, keep: [], restore: [] });
    const nulls = straightSelectionOf(PAGES, ['g']);
    expect(nulls).toMatchObject({ count: 1, keep: [], restore: [] });
    expect(straightSelectionText(t, nulls)).toBe('Из 1 выделенных: выравнивание не применялось.');
  });

  it('подпись действия: «— k из n выделенных» или «— n стр.», если подходят все', () => {
    expect(straightActionLabel(t, 'keep', 3, 5)).toBe('Оставить оригинал — 3 из 5 выделенных');
    expect(straightActionLabel(t, 'restore', 5, 5)).toBe('Выровнять — 5 стр.');
  });

  it('подпись карточки и факт — по статусу и причине', () => {
    expect(thumbStraightLabel(t, 'Страница 1', mark('straightened'))).toBe('Страница 1, выровнена');
    expect(thumbStraightLabel(t, 'Страница 1', mark('deferred', 'disk'))).toBe(
      'Страница 1, не выровнена: мало места на диске',
    );
    expect(thumbStraightLabel(t, 'Страница 1', mark('kept'))).toBe('Страница 1');
    expect(straightFactText(t, mark('deferred', 'fail'))).toBe('отложено — сбой');
    expect(straightFactText(t, mark('level'))).toBe('ровная');
    expect(straightFactText(t, mark(null))).toBeNull();
  });

  it('текст секции у выправленной с отложенным пересчётом — про прежний вид и причину; пересчёт в ходу — прежний текст (B-19)', () => {
    expect(straightNoteText(t, mark('straightened', null, 'disk'))).toBe(
      'Показан выправленный вид прежней версии приложения. Пересчёт отложен: не хватило места на диске — освободите место, при следующем запуске приложение попробует снова.',
    );
    expect(straightNoteText(t, mark('straightened', null, 'fail'))).toBe(
      'Показан выправленный вид прежней версии приложения. Пересчёт не удался из-за сбоя — при следующем запуске приложение попробует снова.',
    );
    expect(straightNoteText(t, mark('straightened', null, 'pending'))).toBe(
      straightNoteText(t, mark('straightened')),
    );
    // Сводка выделения и подписи пересчёт не учитывают: такая страница — выровненная.
    expect(straightNoteText(t, mark('kept', null, 'disk'))).toBe(straightNoteText(t, mark('kept')));
    expect(thumbStraightLabel(t, 'Страница 1', mark('straightened', null, 'disk'))).toBe(
      'Страница 1, выровнена',
    );
    const selection = straightSelectionOf(
      [page('a', mark('straightened', null, 'disk')), page('b', mark('straightened'))],
      ['a', 'b'],
    );
    expect(selection).toMatchObject({ count: 2, straightened: 2, keep: ['a', 'b'] });
  });
});
