import { EMPTY_EDITS, type PageSnapshot, type PassSnapshot, type SessionSnapshot } from '@shared';
import { describe, expect, it } from 'vitest';
import { assembleSession } from './assembly';

// Табличные тесты правила пар (план M2, U2; KTD-4) — обязательная зона тест-политики: сборка
// решает, в каком порядке страницы лягут в документ, и молча ошибиться здесь нельзя.

const pagesOf = (pass: number, count: number, lost: readonly number[] = []): PageSnapshot[] =>
  Array.from({ length: count }, (_value, index) => ({
    key: `p${String(pass).padStart(2, '0')}-s01-${String(index + 1).padStart(4, '0')}`,
    number: index + 1,
    lost: lost.includes(index + 1),
  }));

const passOf = (
  number: number,
  count: number,
  extra: Partial<PassSnapshot> = {},
): PassSnapshot => ({
  number,
  state: 'completed',
  paramsKnown: true,
  scanner: null,
  rotate180: false,
  pages: pagesOf(number, count),
  ...extra,
});

const sessionOf = (
  passes: PassSnapshot[],
  extra: Partial<SessionSnapshot> = {},
): SessionSnapshot => ({
  id: 'a1b2c3d4e5f60718',
  backsDeclined: false,
  saved: false,
  edits: EMPTY_EDITS,
  passes,
  ...extra,
});

/** Порядок в читаемом виде: «1л», «1о», …; лишний оборот — «?о». */
const shape = (session: SessionSnapshot): string[] =>
  assembleSession(session).order.map(
    (page) => `${page.sheet ?? '?'}${page.side === 'front' ? 'л' : 'о'}`,
  );

describe('сборка: interleave и пары (KTD-4)', () => {
  it('равные проходы 3+3: 1л,1о,2л,2о,3л,3о; первый оборот — у последнего листа', () => {
    const session = sessionOf([passOf(1, 3), passOf(2, 3)]);
    const { order, report } = assembleSession(session);

    expect(shape(session)).toEqual(['1л', '1о', '2л', '2о', '3л', '3о']);
    // Обороты пришли в обратном порядке: оборот листа 3 — ПЕРВАЯ страница прохода оборотов.
    const backKeyOfSheet = (sheet: number) =>
      order.find((page) => page.side === 'back' && page.sheet === sheet)?.key;
    expect(backKeyOfSheet(3)).toBe('p02-s01-0001');
    expect(backKeyOfSheet(2)).toBe('p02-s01-0002');
    expect(backKeyOfSheet(1)).toBe('p02-s01-0003');
    expect(report).toMatchObject({
      fronts: 3,
      backs: 3,
      pairs: 3,
      unpairedSheets: [],
      extraBacks: 0,
      mismatch: false,
    });
  });

  it('оборотов меньше на один: непарный — лист №1 (младший), пары не съехали', () => {
    const session = sessionOf([passOf(1, 3), passOf(2, 2)]);
    const { order, report } = assembleSession(session);

    expect(shape(session)).toEqual(['1л', '2л', '2о', '3л', '3о']);
    expect(order.find((page) => page.side === 'back' && page.sheet === 3)?.key).toBe(
      'p02-s01-0001',
    );
    expect(report).toMatchObject({ pairs: 2, unpairedSheets: [1], extraBacks: 0, mismatch: true });
  });

  it('оборотов не хватает на три: непарные — младшие листы по возрастанию', () => {
    const session = sessionOf([passOf(1, 5), passOf(2, 2)]);

    expect(assembleSession(session).report.unpairedSheets).toEqual([1, 2, 3]);
  });

  it('оборотов больше (двойной захват в первом): лишние — в конце, не выброшены', () => {
    const session = sessionOf([passOf(1, 2), passOf(2, 3)]);
    const { order, report } = assembleSession(session);

    expect(shape(session)).toEqual(['1л', '1о', '2л', '2о', '?о']);
    // Лишний оборот — последняя страница прохода оборотов, лист неизвестен.
    expect(order.at(-1)).toMatchObject({ key: 'p02-s01-0003', side: 'back', sheet: null });
    expect(report).toMatchObject({ pairs: 2, unpairedSheets: [], extraBacks: 1, mismatch: true });
  });

  it('«обороты не нужны»: только лицевые, несовпадения нет', () => {
    const session = sessionOf([passOf(1, 3)], { backsDeclined: true });
    const { report } = assembleSession(session);

    expect(shape(session)).toEqual(['1л', '2л', '3л']);
    expect(report).toMatchObject({
      backs: 0,
      backsState: null,
      backsDeclined: true,
      mismatch: false,
    });
  });

  it('проход оборотов прерван и принят: сборка по фактическим парам, состояние в отчёте', () => {
    const session = sessionOf([passOf(1, 3), passOf(2, 1, { state: 'accepted' })]);
    const { report } = assembleSession(session);

    expect(shape(session)).toEqual(['1л', '2л', '3л', '3о']);
    expect(report).toMatchObject({ backsState: 'accepted', unpairedSheets: [1, 2], pairs: 1 });
  });

  it('один лист двусторонне: 1л,1о', () => {
    expect(shape(sessionOf([passOf(1, 1), passOf(2, 1)]))).toEqual(['1л', '1о']);
  });

  it('пустой снимок и один проход: отчёт нулевой, несовпадения нет', () => {
    expect(assembleSession(sessionOf([])).report).toMatchObject({
      fronts: 0,
      backs: 0,
      pairs: 0,
      mismatch: false,
    });
    expect(assembleSession(sessionOf([passOf(1, 2)])).report).toMatchObject({
      fronts: 2,
      backs: 0,
      unpairedSheets: [],
      mismatch: false,
    });
  });
});

describe('сборка: роль прохода и флаг поворота', () => {
  it('роль — позиция среди уцелевших: после остановки обороты — проход №3', () => {
    const session = sessionOf([passOf(1, 2), passOf(3, 2, { rotate180: true })]);
    const { order, report } = assembleSession(session);

    expect(report.pairs).toBe(2);
    expect(order.filter((page) => page.side === 'back').map((page) => page.key)).toEqual([
      'p03-s01-0002',
      'p03-s01-0001',
    ]);
  });

  it('пустой проход роли не занимает: лицевые — первый непустой', () => {
    const empty = passOf(1, 0, { state: 'interrupted' });
    const session = sessionOf([empty, passOf(2, 2), passOf(3, 2)]);

    expect(shape(session)).toEqual(['1л', '1о', '2л', '2о']);
  });

  it('поворот прокидывается только к оборотам; флаг лицевого прохода роли не играет', () => {
    const session = sessionOf([
      passOf(1, 2, { rotate180: true }),
      passOf(2, 2, { rotate180: true }),
    ]);
    const { order } = assembleSession(session);

    expect(order.map((page) => [page.side, page.rotate180])).toEqual([
      ['front', false],
      ['back', true],
      ['front', false],
      ['back', true],
    ]);
  });

  it('выключенный поворот — обороты без признака', () => {
    const { order } = assembleSession(sessionOf([passOf(1, 1), passOf(2, 1)]));

    expect(order.every((page) => !page.rotate180)).toBe(true);
  });
});

describe('сборка: ничего не теряется', () => {
  it('каждая страница сессии попадает в порядок ровно один раз, потерянные — на месте', () => {
    const fronts = passOf(1, 4);
    const backs = passOf(2, 6, { pages: pagesOf(2, 6, [2]) });
    const session = sessionOf([fronts, backs]);
    const { order } = assembleSession(session);

    const expected = [...fronts.pages, ...backs.pages].map((page) => page.key).sort();
    expect(order.map((page) => page.key).sort()).toEqual(expected);
    expect(order.filter((page) => page.lost).map((page) => page.key)).toEqual(['p02-s01-0002']);
  });

  it('третий набор в M2 не собирается, но и не выбрасывается: страницы в конце', () => {
    const session = sessionOf([passOf(1, 1), passOf(2, 1), passOf(3, 2)]);
    const { order, report } = assembleSession(session);

    expect(order.map((page) => page.key)).toEqual([
      'p01-s01-0001',
      'p02-s01-0001',
      'p03-s01-0001',
      'p03-s01-0002',
    ]);
    expect(report).toMatchObject({ fronts: 1, backs: 1, pairs: 1 });
  });
});
