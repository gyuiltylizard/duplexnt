import { EMPTY_EDITS, type AssembledPage, type SessionSnapshot } from '@shared';
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
import { assembleSession, baseAssembly, baseKeysOf } from './assembly';

// Двусторонние добавленные наборы в сборке (план M4.5, U3; KTD5): блок пары по якорю лиц с
// чередованием при равном числе страниц и подблоками при неравном, отчёт по наборам «ДN»,
// набор, ждущий обороты, флаг 180° по проходу страницы, осиротевшие обороты. Обязательная зона
// тест-политики: порядок страниц в документе и «ничего не теряется».

const F = (index: number): string => keyOf(1, index);
const B = (index: number): string => keyOf(2, index);
const SF = (index: number): string => keyOf(3, index);
const SB = (index: number): string => keyOf(4, index);

/** Основная пачка 3+3: F1 B3 F2 B2 F3 B1. */
const MAIN = [passOf(1, 3), passOf(2, 3)];
const keysOf = (session: SessionSnapshot): string[] =>
  assembleSession(session).order.map((page) => page.key);
const pageOf = (session: SessionSnapshot, key: string): AssembledPage | undefined =>
  assembleSession(session).order.find((page) => page.key === key);
const shapeOf = (page: AssembledPage | undefined) =>
  page === undefined
    ? undefined
    : { side: page.side, sheet: page.sheet, addedSet: page.addedSet, angle: page.angle };

describe('сборка: блок пары добавленного набора (M4.5, R12, R13; KTD5)', () => {
  it('равные проходы набора — чередование по якорю лиц: лицо i, оборот F−1−i; лист внутри набора; тег «ДN» на обеих сторонах (AE1)', () => {
    const session = sessionOf([...MAIN, setFrontsOf(3, 3, F(2)), setBacksOf(4, 3, 3)]);

    expect(keysOf(session)).toEqual([
      F(1),
      B(3),
      F(2),
      SF(1),
      SB(3),
      SF(2),
      SB(2),
      SF(3),
      SB(1),
      B(2),
      F(3),
      B(1),
    ]);
    expect(shapeOf(pageOf(session, SF(1)))).toEqual({
      side: 'front',
      sheet: 1,
      addedSet: 1,
      angle: 0,
    });
    expect(shapeOf(pageOf(session, SB(3)))).toEqual({
      side: 'back',
      sheet: 1,
      addedSet: 1,
      angle: 0,
    });
    expect(shapeOf(pageOf(session, SF(3)))).toEqual({
      side: 'front',
      sheet: 3,
      addedSet: 1,
      angle: 0,
    });
    expect(shapeOf(pageOf(session, SB(1)))).toEqual({
      side: 'back',
      sheet: 3,
      addedSet: 1,
      angle: 0,
    });
    // Основная пачка — как без набора.
    expect(shapeOf(pageOf(session, B(1)))).toEqual({
      side: 'back',
      sheet: 3,
      addedSet: null,
      angle: 0,
    });
    expect(assembleSession(session).report).toMatchObject({
      mode: 'pairs',
      mismatch: false,
      pendingSet: null,
      sets: [
        {
          set: 1,
          fronts: 3,
          backs: 3,
          backsState: 'completed',
          decision: 'none',
          mismatch: false,
          sides: 'two',
        },
      ],
    });
  });

  it('обороты набора короче (завершённые) — подблоки: лица по порядку, обороты порядком документа, без листов; mismatch набора в отчёте (AE2)', () => {
    const session = sessionOf([...MAIN, setFrontsOf(3, 3, F(2)), setBacksOf(4, 3, 2)]);

    expect(keysOf(session)).toEqual([
      F(1),
      B(3),
      F(2),
      SF(1),
      SF(2),
      SF(3),
      SB(2),
      SB(1),
      B(2),
      F(3),
      B(1),
    ]);
    expect(shapeOf(pageOf(session, SF(2)))).toEqual({
      side: 'front',
      sheet: null,
      addedSet: 1,
      angle: 0,
    });
    expect(shapeOf(pageOf(session, SB(2)))).toEqual({
      side: 'back',
      sheet: null,
      addedSet: 1,
      angle: 0,
    });
    const { report } = assembleSession(session);
    expect(report.sets[0]).toMatchObject({ backs: 2, backsState: 'completed', mismatch: true });
    // Режим сессии несовпадение набора не трогает (R12).
    expect(report).toMatchObject({ mode: 'pairs', mismatch: false, pendingSet: null });
  });

  it('прерванные обороты набора с одной страницей — подблоки; досканирование до равенства — чередование (AE11)', () => {
    const interrupted = sessionOf([
      ...MAIN,
      setFrontsOf(3, 3, F(2)),
      setBacksOf(4, 3, 1, { state: 'interrupted' }),
    ]);
    expect(keysOf(interrupted).slice(3, 7)).toEqual([SF(1), SF(2), SF(3), SB(1)]);
    expect(assembleSession(interrupted).report.sets[0]).toMatchObject({
      backsState: 'interrupted',
      mismatch: true,
    });

    // Второй сегмент прохода оборотов довёл число до трёх: оборот листа i — страница F−1−i.
    const resumed = sessionOf([
      ...MAIN,
      setFrontsOf(3, 3, F(2)),
      setBacksOf(4, 3, 0, {
        pages: [
          ...pagesOf(4, 1),
          { key: 'p04-s02-0001', number: 2, lost: false },
          { key: 'p04-s02-0002', number: 3, lost: false },
        ],
      }),
    ]);
    expect(keysOf(resumed).slice(3, 9)).toEqual([
      SF(1),
      'p04-s02-0002',
      SF(2),
      'p04-s02-0001',
      SF(3),
      SB(1),
    ]);
    expect(assembleSession(resumed).report.sets[0]).toMatchObject({ backs: 3, mismatch: false });
  });

  it('принятые короткие обороты набора — подблоки, решение «оставить» в отчёте', () => {
    const session = sessionOf([
      ...MAIN,
      setFrontsOf(3, 3, F(2), { backsDecision: 'kept' }),
      setBacksOf(4, 3, 2, { state: 'accepted' }),
    ]);

    expect(keysOf(session).slice(3, 8)).toEqual([SF(1), SF(2), SF(3), SB(2), SB(1)]);
    expect(assembleSession(session).report.sets[0]).toMatchObject({
      backsState: 'accepted',
      decision: 'kept',
      mismatch: true,
    });
  });

  it('набор ждёт обороты: лица блоком по якорю, `pendingSet` — номер «ДN»; после отказа или при прерванных лицах — null', () => {
    const waiting = sessionOf([...MAIN, setFrontsOf(3, 2, F(2))]);
    expect(keysOf(waiting)).toEqual([F(1), B(3), F(2), SF(1), SF(2), B(2), F(3), B(1)]);
    expect(shapeOf(pageOf(waiting, SF(2)))).toEqual({
      side: 'front',
      sheet: null,
      addedSet: 1,
      angle: 0,
    });
    expect(assembleSession(waiting).report).toMatchObject({
      pendingSet: 1,
      sets: [{ set: 1, fronts: 2, backs: 0, backsState: null, decision: 'none', sides: 'two' }],
    });

    const declined = sessionOf([...MAIN, setFrontsOf(3, 2, F(2), { backsDecision: 'declined' })]);
    expect(keysOf(declined)).toEqual(keysOf(waiting));
    expect(assembleSession(declined).report).toMatchObject({
      pendingSet: null,
      sets: [{ decision: 'declined' }],
    });

    const interrupted = sessionOf([...MAIN, setFrontsOf(3, 2, F(2), { state: 'interrupted' })]);
    expect(assembleSession(interrupted).report.pendingSet).toBeNull();
    const accepted = sessionOf([...MAIN, setFrontsOf(3, 2, F(2), { state: 'accepted' })]);
    expect(assembleSession(accepted).report.pendingSet).toBe(1);
  });

  it('нумерация «ДN» — по номеру прохода лиц среди всех наборов; якорь внутри блока пары; односторонний на обороте пары', () => {
    const session = sessionOf([
      ...MAIN,
      addedOf(3, 1, F(1)),
      setFrontsOf(4, 2, F(2)),
      setBacksOf(5, 4, 2),
      addedOf(6, 1, keyOf(5, 1)),
    ]);

    expect(keysOf(session)).toEqual([
      F(1),
      keyOf(3, 1),
      B(3),
      F(2),
      keyOf(4, 1),
      keyOf(5, 2),
      keyOf(4, 2),
      keyOf(5, 1),
      keyOf(6, 1),
      B(2),
      F(3),
      B(1),
    ]);
    expect(pageOf(session, keyOf(3, 1))?.addedSet).toBe(1);
    expect(pageOf(session, keyOf(5, 2))?.addedSet).toBe(2);
    expect(pageOf(session, keyOf(6, 1))?.addedSet).toBe(3);
    expect(assembleSession(session).report.sets.map((set) => [set.set, set.sides])).toEqual([
      [1, 'one'],
      [2, 'two'],
      [3, 'one'],
    ]);
  });

  it('пара без якоря или с пропавшим якорем — блоком в конец; осиротевшие обороты набора — в конец стороной «оборот», без тега', () => {
    const lostAnchor = sessionOf([...MAIN, setFrontsOf(3, 2, 'p09-s01-0001'), setBacksOf(4, 3, 2)]);
    expect(keysOf(lostAnchor).slice(6)).toEqual([SF(1), SB(2), SF(2), SB(1)]);

    const orphan = sessionOf([...MAIN, setBacksOf(4, 3, 2)]);
    expect(keysOf(orphan).slice(6)).toEqual([SB(2), SB(1)]);
    expect(shapeOf(pageOf(orphan, SB(2)))).toEqual({
      side: 'back',
      sheet: null,
      addedSet: null,
      angle: 0,
    });
    expect(assembleSession(orphan).report).toMatchObject({ sets: [], pendingSet: null });
  });

  it('флаг 180°: угол оборотов набора — по флагу их прохода, основной пачки — по своему; лица набора — 0 (R16)', () => {
    const setRotated = sessionOf([
      ...MAIN,
      setFrontsOf(3, 2, F(2)),
      setBacksOf(4, 3, 2, { rotate180: true }),
    ]);
    const angles = (session: SessionSnapshot) =>
      Object.fromEntries(assembleSession(session).order.map((page) => [page.key, page.angle]));

    expect(angles(setRotated)).toMatchObject({ [B(1)]: 0, [SB(1)]: 180, [SB(2)]: 180, [SF(1)]: 0 });
    expect(assembleSession(setRotated).hasEdits).toBe(true);

    const mainRotated = sessionOf([
      passOf(1, 3),
      passOf(2, 3, { rotate180: true }),
      setFrontsOf(3, 2, F(2)),
      setBacksOf(4, 3, 2),
    ]);
    expect(angles(mainRotated)).toMatchObject({ [B(1)]: 180, [SB(1)]: 0, [SF(1)]: 0 });
    // Ручной угол складывается с флагом прохода страницы.
    const edited = sessionOf([...setRotated.passes], {
      edits: { ...EMPTY_EDITS, rotations: { [SB(1)]: 90 } },
    });
    expect(angles(edited)[SB(1)]).toBe(270);
  });

  it('режим «собрано»: пара вне записи — блоком по якорю лиц с чередованием, не по одной странице (AE13)', () => {
    const record = [F(1), B(2), F(2), B(1), F(3)];
    const session = sessionOf(
      [passOf(1, 3), passOf(2, 2), setFrontsOf(3, 2, F(2)), setBacksOf(4, 3, 2)],
      { assembled: record },
    );

    expect(keysOf(session)).toEqual([F(1), B(2), F(2), SF(1), SB(2), SF(2), SB(1), B(1), F(3)]);
    expect(shapeOf(pageOf(session, SB(2)))).toEqual({
      side: 'back',
      sheet: 1,
      addedSet: 1,
      angle: 0,
    });
    expect(shapeOf(pageOf(session, SF(2)))).toEqual({
      side: 'front',
      sheet: 2,
      addedSet: 1,
      angle: 0,
    });
    // Страницы записи — сторона и лист по позиции, как прежде.
    expect(shapeOf(pageOf(session, B(1)))).toEqual({
      side: 'back',
      sheet: 2,
      addedSet: null,
      angle: 0,
    });
    expect(assembleSession(session).report).toMatchObject({
      mode: 'assembled',
      sets: [{ set: 1 }],
    });
  });

  it('режим «собрано»: набор, которого запись коснулась, достраивается по одной странице — за предыдущей своего прохода', () => {
    const session = sessionOf(
      [passOf(1, 3), passOf(2, 2), setFrontsOf(3, 2, F(2)), setBacksOf(4, 3, 2)],
      { assembled: [F(1), B(2), F(2), SF(1), B(1), F(3)] },
    );

    expect(keysOf(session)).toEqual([F(1), B(2), F(2), SF(1), SF(2), B(1), F(3), SB(1), SB(2)]);
    expect(shapeOf(pageOf(session, SB(1)))).toEqual({
      side: 'back',
      sheet: null,
      addedSet: 1,
      angle: 0,
    });
  });

  it('`settled`-проекция идущих оборотов набора — всегда подблоки: новый оборот при явном порядке встаёт за соседом по проходу (R12)', () => {
    const passes = [...MAIN, setFrontsOf(3, 2, F(2)), setBacksOf(4, 3, 2, { state: 'running' })];

    expect(baseKeysOf(baseAssembly(passes, null)).slice(3, 7)).toEqual([
      SF(1),
      SB(2),
      SF(2),
      SB(1),
    ]);
    expect(baseKeysOf(baseAssembly(passes, null, true)).slice(3, 7)).toEqual([
      SF(1),
      SF(2),
      SB(2),
      SB(1),
    ]);
  });

  it('каждая страница сессии — ровно один раз: пары, подблоки, осиротевшие, пустые проходы', () => {
    const session = sessionOf([
      ...MAIN,
      setFrontsOf(3, 3, F(2)),
      setBacksOf(4, 3, 2),
      setFrontsOf(5, 0, F(1), { state: 'interrupted' }),
      setBacksOf(6, 5, 1),
      addedOf(7, 1, SB(1)),
      setFrontsOf(8, 1, null),
    ]);
    const keys = keysOf(session);
    const all = session.passes.flatMap((pass) => pass.pages.map((page) => page.key)).sort();

    expect([...keys].sort()).toEqual(all);
    expect(new Set(keys).size).toBe(keys.length);
    expect(assembleSession(session).report).toMatchObject({
      pendingSet: 3,
      sets: [
        { set: 1, sides: 'two' },
        { set: 2, sides: 'one' },
        { set: 3, sides: 'two' },
      ],
    });
  });
});
