import {
  EMPTY_EDITS,
  NO_STRAIGHTEN,
  type SessionSnapshot,
  type StraightenFact,
  type StraightenFacts,
  type StraightenStatus,
} from '@shared';
import { describe, expect, it } from 'vitest';
import { keyOf, pagesOf, passOf, sessionOf } from '../../../test/support/assembly';
import { assembleSession } from './assembly';

// Статусы выравнивания в ленте ядра (план M6, U12; KTD-9): факты ядра × режим сессии × флаг
// пустоты × откат. Само правило — `straightenMarkOf` (табличный тест в `@shared`); здесь —
// проводка: кто получает статус, что в сводку, что `null`.

const F = (index: number): string => keyOf(1, index);
const B = (index: number): string => keyOf(2, index);

const fact = (overrides: Partial<StraightenFact>): StraightenFact => ({
  outcome: null,
  corrected: false,
  version: overrides.corrected === true ? 1 : null,
  deferred: null,
  ...overrides,
});

const statusesOf = (
  session: SessionSnapshot,
  facts: StraightenFacts,
  blank = new Map<string, boolean>(),
): Record<string, StraightenStatus> =>
  Object.fromEntries(
    assembleSession(session, blank, facts).order.map((page) => [page.key, page.straighten.status]),
  );

describe('сборка: статусы выравнивания (M6, KTD-9)', () => {
  const pairs = sessionOf([passOf(1, 2), passOf(2, 2)], { blankMode: 'hide', straighten: 'auto' });

  it('статусы для всех исходов; без фактов — ждёт; сводка считает все, кроме null', () => {
    const facts: StraightenFacts = new Map([
      [F(1), fact({ outcome: 'willStraighten', corrected: true })],
      [F(2), fact({ outcome: 'unmeasurable' })],
      [B(2), fact({ outcome: 'level' })],
    ]);
    const blank = new Map([
      [B(1), false],
      [B(2), false],
    ]);

    expect(statusesOf(pairs, facts, blank)).toEqual({
      [F(1)]: 'straightened',
      [B(2)]: 'level',
      [F(2)]: 'unmeasurable',
      [B(1)]: 'pending',
    });
    expect(assembleSession(pairs, blank, facts).straighten).toEqual({
      mode: 'auto',
      straightened: 1,
      kept: 0,
      level: 1,
      unmeasurable: 1,
      deferred: 0,
      pending: 1,
      total: 4,
      reasons: { measure: 1, nohelp: 0, disk: 0, fail: 0 },
    });
  });

  it('пустой оборот (скрыт или помечен) — null, оборот без вердикта пустоты — ждёт; потерянная — null', () => {
    const lost = sessionOf([passOf(1, 2, { pages: pagesOf(1, 2, [2]) }), passOf(2, 2)], {
      blankMode: 'mark',
      straighten: 'auto',
    });
    const facts: StraightenFacts = new Map([[B(1), fact({ outcome: 'willStraighten' })]]);

    expect(statusesOf(lost, facts, new Map([[B(1), true]]))).toEqual({
      [F(1)]: 'pending',
      [B(2)]: 'pending',
      [F(2)]: null,
      [B(1)]: null,
    });
    const assembly = assembleSession(lost, new Map([[B(1), true]]), facts);
    expect(assembly.straighten).toMatchObject({ pending: 2, total: 2 });
    // Скрытый при «Скрывать» остаётся в ленте (отсеивает запись), статус null, в сводке его нет.
    const hidden = assembleSession(pairs, new Map([[B(1), true]]), facts);
    expect(hidden.order.find((page) => page.key === B(1))).toMatchObject({
      blank: 'hidden',
      straighten: { status: null, reason: null, version: null },
    });
    expect(hidden.straighten.total).toBe(3);
  });

  it('режим сессии «не выравнивать»: статусы null, сводка нулевая с режимом', () => {
    const off = sessionOf([passOf(1, 2)], { straighten: 'off' });
    const facts: StraightenFacts = new Map([
      [F(1), fact({ outcome: 'willStraighten', corrected: true })],
    ]);

    expect(statusesOf(off, facts)).toEqual({ [F(1)]: null, [F(2)]: null });
    expect(assembleSession(off, undefined, facts).straighten).toEqual(NO_STRAIGHTEN);
    // Без третьего аргумента сборка — как до M6: в режиме «выравнивать» все ждут.
    expect(assembleSession(pairs).straighten).toMatchObject({ mode: 'auto', pending: 4 });
  });

  it('откат «Оставить оригинал» даёт kept только выправленной; мёртвый ключ вычищен; отложенные — deferred с причиной, не pending', () => {
    const facts: StraightenFacts = new Map([
      [F(1), fact({ outcome: 'willStraighten', corrected: true })],
      [F(2), fact({ outcome: 'willStraighten', deferred: 'noSpace' })],
      [B(1), fact({ outcome: 'willStraighten', deferred: 'failed' })],
      [B(2), fact({ outcome: 'level' })],
    ]);
    const session = sessionOf([passOf(1, 2), passOf(2, 2)], {
      straighten: 'auto',
      edits: { ...EMPTY_EDITS, keepOriginal: [F(1), F(2), 'p09-s01-0001'] },
    });

    const assembly = assembleSession(session, undefined, facts);
    expect(Object.fromEntries(assembly.order.map((page) => [page.key, page.straighten]))).toEqual({
      [F(1)]: { status: 'kept', reason: null, version: 1 },
      [B(2)]: { status: 'level', reason: null, version: null },
      [F(2)]: { status: 'deferred', reason: 'disk', version: null },
      [B(1)]: { status: 'deferred', reason: 'fail', version: null },
    });
    expect(assembly.straighten).toMatchObject({
      kept: 1,
      deferred: 2,
      pending: 0,
      reasons: { disk: 1, fail: 1 },
    });
    expect(assembly.hasEdits).toBe(true);
  });

  it('удалённые правкой страницы в сводку не входят; статусы не двигают ленту', () => {
    const facts: StraightenFacts = new Map([
      [F(1), fact({ outcome: 'willStraighten', corrected: true })],
    ]);
    const session = sessionOf([passOf(1, 2), passOf(2, 2)], {
      straighten: 'auto',
      edits: { ...EMPTY_EDITS, deleted: [F(1)] },
    });
    const assembly = assembleSession(session, undefined, facts);
    expect(assembly.straighten).toMatchObject({ straightened: 0, pending: 3, total: 3 });
    expect(assembly.order.map((page) => page.key)).toEqual(
      assembleSession(session).order.map((page) => page.key),
    );
  });
});
