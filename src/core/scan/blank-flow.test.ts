import { describe, expect, it } from 'vitest';
import {
  addedOf,
  keyOf,
  pagesOf,
  passOf,
  sessionOf,
  setBacksOf,
  setFrontsOf,
} from '../../../test/support/assembly';
import { pagesToScore } from './blank-flow';

// Какие страницы оценивает детектор (M4, KTD9; M4.5, KTD6): роли «обороты» основной пачки и
// добавленных наборов, не потерянные, при режиме ≠ «Оставлять». Отказы записи — в
// `pass-service.blank.test.ts`.

const keys = (pages: ReturnType<typeof pagesToScore>): string[] => pages.map((page) => page.key);

describe('детектор: страницы под оценку', () => {
  const session = sessionOf(
    [
      passOf(1, 3),
      passOf(2, 3, { pages: pagesOf(2, 3, [2]) }),
      setFrontsOf(3, 2, keyOf(1, 2)),
      setBacksOf(4, 3, 2),
      addedOf(5, 1, null),
      setBacksOf(6, 9, 1),
    ],
    { blankMode: 'hide' },
  );

  it('обороты основной пачки и наборов — включая осиротевшие; без потерянных, лиц и односторонних', () => {
    expect(keys(pagesToScore(session))).toEqual([
      keyOf(2, 1),
      keyOf(2, 3),
      keyOf(4, 1),
      keyOf(4, 2),
      keyOf(6, 1),
    ]);
    expect(keys(pagesToScore({ ...session, blankMode: 'mark' }))).toHaveLength(5);
  });

  it('при «Оставлять» и без сессии оценивать нечего', () => {
    expect(pagesToScore({ ...session, blankMode: 'keep' })).toEqual([]);
    expect(pagesToScore(null)).toEqual([]);
  });

  it('пустой проход оборотов набора роли не занимает — страниц под оценку не даёт', () => {
    const empty = sessionOf(
      [
        passOf(1, 2),
        passOf(2, 2),
        setFrontsOf(3, 1, null),
        setBacksOf(4, 3, 0, { state: 'interrupted' }),
      ],
      { blankMode: 'hide' },
    );

    expect(keys(pagesToScore(empty))).toEqual([keyOf(2, 1), keyOf(2, 2)]);
  });
});
