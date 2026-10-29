import { describe, expect, it } from 'vitest';
import {
  addedOf,
  keyOf,
  pagesOf,
  passOf,
  sessionOf,
  setBacksOf,
} from '../../../test/support/assembly';
import { pagesToMeasure } from './straighten-flow';

// Какие страницы измеряет детектор перекоса (M6, U5; R6): все проходы в режиме «выравнивать»,
// без потерянных; обороты при оцениваемой пустоте — только с вердиктом «не пусто» или пометкой
// «не пустая». Проводка в службе — `pass-service.straighten.test.ts`.

const keys = (pages: ReturnType<typeof pagesToMeasure>): string[] => pages.map((page) => page.key);

describe('выравнивание: страницы под измерение', () => {
  const session = sessionOf(
    [
      passOf(1, 2, { pages: pagesOf(1, 2, [2]) }),
      passOf(2, 3),
      addedOf(3, 1, null),
      setBacksOf(4, 2, 1),
    ],
    { blankMode: 'hide', straighten: 'auto' },
  );
  const verdicts = new Map([
    [keyOf(2, 1), false],
    [keyOf(2, 2), true],
    [keyOf(4, 1), false],
  ]);

  it('лица и односторонние — всегда; обороты — по вердикту «не пусто»; без вердикта — ждут; потерянные — нет', () => {
    expect(keys(pagesToMeasure(session, verdicts))).toEqual([
      keyOf(1, 1),
      keyOf(2, 1),
      keyOf(3, 1),
      keyOf(4, 1),
    ]);
  });

  it('пометка «не пустая» возвращает оборот под измерение — и без вердикта, и при «пусто»', () => {
    const marked = {
      ...session,
      edits: { ...session.edits, notBlank: [keyOf(2, 2), keyOf(2, 3)] },
    };
    expect(keys(pagesToMeasure(marked, verdicts))).toEqual([
      keyOf(1, 1),
      keyOf(2, 1),
      keyOf(2, 2),
      keyOf(2, 3),
      keyOf(3, 1),
      keyOf(4, 1),
    ]);
  });

  it('при «Оставлять» пустоты обороты измеряются все: вердиктов нет', () => {
    expect(keys(pagesToMeasure({ ...session, blankMode: 'keep' }, new Map()))).toEqual([
      keyOf(1, 1),
      keyOf(2, 1),
      keyOf(2, 2),
      keyOf(2, 3),
      keyOf(3, 1),
      keyOf(4, 1),
    ]);
  });

  it('режим «не выравнивать» и отсутствие сессии — никого', () => {
    expect(pagesToMeasure({ ...session, straighten: 'off' }, verdicts)).toEqual([]);
    expect(pagesToMeasure(null, verdicts)).toEqual([]);
  });
});
