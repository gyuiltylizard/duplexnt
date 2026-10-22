import { EMPTY_EDITS, type BlankFlag, type BlankMode, type SessionSnapshot } from '@shared';
import { describe, expect, it } from 'vitest';
import { addedOf, keyOf, pagesOf, passOf, sessionOf } from '../../../test/support/assembly';
import { assembleSession } from './assembly';

// Флаги пустых оборотов в ленте ядра (план M4, U4; R10, KTD4, KTD9): табличный тест режим ×
// режим сборки × оценка. Обязательная зона тест-политики: флаг решает, попадёт ли страница в
// файл, и молча потерять страницу нельзя.

const F = (index: number): string => keyOf(1, index);
const B = (index: number): string => keyOf(2, index);

/** Вердикты: ключи `blank` — пусто, `content` — не пусто; остальные без оценки. */
const verdictsOf = (blank: readonly string[], content: readonly string[] = []) =>
  new Map<string, boolean>([
    ...blank.map((key): [string, boolean] => [key, true]),
    ...content.map((key): [string, boolean] => [key, false]),
  ]);

const flagsOf = (session: SessionSnapshot, verdicts = verdictsOf([])) =>
  Object.fromEntries(
    assembleSession(session, verdicts).order.map((page) => [page.key, page.blank]),
  ) as Record<string, BlankFlag>;

const pairs = (mode: BlankMode, extra: Partial<SessionSnapshot> = {}) =>
  sessionOf([passOf(1, 3), passOf(2, 3)], { blankMode: mode, ...extra });

describe('сборка: флаги пустых оборотов (M4, R10)', () => {
  it('«Скрывать» в парах: пустой оборот скрыт, остальные обычные; лица без флага при любом вердикте', () => {
    const verdicts = verdictsOf([B(1), F(2)], [B(2)]);

    expect(flagsOf(pairs('hide'), verdicts)).toEqual({
      [F(1)]: null,
      [B(3)]: null,
      [F(2)]: null,
      [B(2)]: null,
      [F(3)]: null,
      [B(1)]: 'hidden',
    });
    expect(assembleSession(pairs('hide'), verdicts).blank).toEqual({
      mode: 'hide',
      found: 1,
      hidden: 1,
      // Без оценки — только оборот B3: лицо F1 не оценивается и не ждёт.
      pending: 1,
    });
  });

  it('«Помечать»: пустой оборот помечен, не скрыт', () => {
    const assembly = assembleSession(pairs('mark'), verdictsOf([B(1), B(2)], [B(3)]));

    expect(assembly.order.map((page) => page.blank)).toEqual([
      null,
      null,
      null,
      'marked',
      null,
      'marked',
    ]);
    expect(assembly.blank).toEqual({ mode: 'mark', found: 2, hidden: 0, pending: 0 });
  });

  it('«Оставлять»: флагов и ожидания нет, какие бы оценки ни пришли', () => {
    const assembly = assembleSession(pairs('keep'), verdictsOf([B(1), B(2), B(3)]));

    expect(assembly.order.every((page) => page.blank === null)).toBe(true);
    expect(assembly.blank).toEqual({ mode: 'keep', found: 0, hidden: 0, pending: 0 });
    expect(assembleSession(pairs('keep')).blank.pending).toBe(0);
  });

  it('без оценок при «Скрывать» все обороты ждут, лента полная', () => {
    const assembly = assembleSession(pairs('hide'));

    expect(assembly.order).toHaveLength(6);
    expect(assembly.blank).toEqual({ mode: 'hide', found: 0, hidden: 0, pending: 3 });
  });

  it('пометка «не пустая» снимает флаг и ожидание; мёртвый ключ пометки вычищен', () => {
    const session = pairs('hide', {
      edits: { ...EMPTY_EDITS, notBlank: [B(1), 'p09-s01-0001'] },
    });
    const assembly = assembleSession(session, verdictsOf([B(1), B(2)], [B(3)]));

    expect(assembly.order.map((page) => page.blank)).toEqual([
      null,
      null,
      null,
      'hidden',
      null,
      null,
    ]);
    expect(assembly.blank).toEqual({ mode: 'hide', found: 1, hidden: 1, pending: 0 });
    expect(assembly.hasEdits).toBe(true);
  });

  it('пометка «не пустая» без вердикта: страница не ждёт оценки — решение пользователя важнее', () => {
    const session = pairs('hide', { edits: { ...EMPTY_EDITS, notBlank: [B(1)] } });

    const assembly = assembleSession(session, verdictsOf([], [B(2), B(3)]));
    expect(assembly.order.every((page) => page.blank === null)).toBe(true);
    expect(assembly.blank).toEqual({ mode: 'hide', found: 0, hidden: 0, pending: 0 });
  });

  it('режим раздельных наборов: «Скрывать» даёт метку, не скрытие; «Помечать» — метку', () => {
    const sets = (mode: BlankMode) => sessionOf([passOf(1, 3), passOf(2, 2)], { blankMode: mode });
    const verdicts = verdictsOf([B(1)], [B(2)]);

    for (const mode of ['hide', 'mark'] as const) {
      const assembly = assembleSession(sets(mode), verdicts);
      expect(assembly.report.mode).toBe('sets');
      expect(flagsOf(sets(mode), verdicts)[B(1)]).toBe('marked');
      expect(assembly.blank).toEqual({ mode, found: 1, hidden: 0, pending: 0 });
    }
  });

  it('после сборки: скрытие вступает; оборот — по проходу, не по позиции', () => {
    // Запись сборки: F1, B2, F2, B1, F3 — B2 на позиции оборота, F2 на позиции лица.
    const session = sessionOf([passOf(1, 3), passOf(2, 2)], {
      blankMode: 'hide',
      assembled: [F(1), B(2), F(2), B(1), F(3)],
    });
    const assembly = assembleSession(session, verdictsOf([B(2), F(2)], [B(1)]));

    expect(assembly.report.mode).toBe('assembled');
    expect(assembly.order.map((page) => page.blank)).toEqual([null, 'hidden', null, null, null]);
    expect(assembly.blank).toEqual({ mode: 'hide', found: 1, hidden: 1, pending: 0 });
  });

  it('добавленный набор не оценивается — даже с якорем в группе оборотов (KTD9)', () => {
    const A1 = keyOf(3, 1);
    const session = sessionOf([passOf(1, 2), passOf(2, 2), addedOf(3, 1, B(1))], {
      blankMode: 'hide',
    });
    const assembly = assembleSession(session, verdictsOf([A1, B(1), B(2)]));

    expect(flagsOf(session, verdictsOf([A1, B(1), B(2)]))[A1]).toBeNull();
    expect(assembly.blank).toEqual({ mode: 'hide', found: 2, hidden: 2, pending: 0 });
  });

  it('потерянная страница не пуста и оценки не ждёт', () => {
    const session = sessionOf([passOf(1, 2), passOf(2, 2, { pages: pagesOf(2, 2, [1]) })], {
      blankMode: 'hide',
    });

    const assembly = assembleSession(session, verdictsOf([B(1)], [B(2)]));
    expect(assembly.order.find((page) => page.key === B(1))).toMatchObject({
      lost: true,
      blank: null,
    });
    expect(assembly.blank).toEqual({ mode: 'hide', found: 0, hidden: 0, pending: 0 });
  });

  it('удалённые правкой страницы не считаются ни найденными, ни ожидающими', () => {
    const session = pairs('hide', { edits: { ...EMPTY_EDITS, deleted: [B(1), B(2)] } });
    const assembly = assembleSession(session, verdictsOf([B(1)]));

    expect(assembly.order).toHaveLength(4);
    expect(assembly.blank).toEqual({ mode: 'hide', found: 0, hidden: 0, pending: 1 });
  });

  it('скрытие не двигает ленту: порядок, разрезы, документы и листы одинаковы при любых оценках', () => {
    const session = pairs('hide', {
      edits: { ...EMPTY_EDITS, cuts: [2, 4], names: ['', '', ''] },
    });
    const without = assembleSession(session);
    const withAll = assembleSession(session, verdictsOf([B(1), B(2), B(3)]));

    const shape = (assembly: ReturnType<typeof assembleSession>) => ({
      keys: assembly.order.map((page) => page.key),
      sheets: assembly.order.map((page) => [page.side, page.sheet]),
      documents: assembly.documents,
      sets: assembly.sets,
    });
    expect(shape(withAll)).toEqual(shape(without));
    expect(withAll.blank.hidden).toBe(3);
    expect(without.blank.hidden).toBe(0);
  });

  it('граница наборов одинакова при любом наборе оценок', () => {
    const session = sessionOf([passOf(1, 3), passOf(2, 2)], {
      blankMode: 'hide',
      edits: { ...EMPTY_EDITS, divider: 2 },
    });

    expect(assembleSession(session, verdictsOf([B(1), B(2)])).sets).toEqual(
      assembleSession(session).sets,
    );
  });

  it('без второго аргумента сборка — как до M4: флагов нет, при «Оставлять» ничего не ждёт', () => {
    expect(assembleSession(pairs('keep')).order.every((page) => page.blank === null)).toBe(true);
  });
});
