import { EMPTY_EDITS, type AssembledPage, type SessionSnapshot } from '@shared';
import { describe, expect, it } from 'vitest';
import { addedOf, keyOf, pagesOf, passOf, sessionOf } from '../../../test/support/assembly';
import { assembleSession, frozenSequenceOf } from './assembly';

// Табличные тесты режимов сборки M3.6 (план M3.6, U2; R4–R11, KTD2–KTD4, KTD7): раздельные
// наборы при несовпадении проходов, запись сборки и режим «собрано». Пары — в `assembly.test.ts`.
// Обязательная зона тест-политики: здесь решается, какие страницы и в каком порядке лягут в
// документ, и молча потерять или задвоить страницу нельзя.

const F = (index: number): string => keyOf(1, index);
const B = (index: number): string => keyOf(2, index);

const keysOf = (session: SessionSnapshot): string[] =>
  assembleSession(session).order.map((page) => page.key);

/** Подпись страницы: «3л», «2о», «?о» — без листа; добавленная — с префиксом «Д1:». */
const label = (page: AssembledPage): string =>
  `${page.addedSet === null ? '' : `Д${page.addedSet}:`}${page.sheet ?? '?'}${
    page.side === 'front' ? 'л' : 'о'
  }`;
const labelsOf = (session: SessionSnapshot): string[] => assembleSession(session).order.map(label);

describe('сборка: режим раздельных наборов (M3.6, U2; R4, R5, R10, R11)', () => {
  it('AE1: 12/11 — лица по порядку, затем обороты обратным порядком подачи; группы 12 и 11', () => {
    const session = sessionOf([passOf(1, 12), passOf(2, 11)]);
    const assembly = assembleSession(session);

    expect(assembly.report).toMatchObject({
      mode: 'sets',
      mismatch: true,
      groups: { fronts: 12, backs: 11, divider: 12 },
      fronts: 12,
      backs: 11,
    });
    expect(assembly.sets).toEqual({ fronts: 12, backs: 11, divider: 12 });
    expect(assembly.documents).toEqual([{ name: '', start: 0, count: 23 }]);
    expect(keysOf(session)).toEqual([
      ...pagesOf(1, 12).map((page) => page.key),
      ...pagesOf(2, 11)
        .map((page) => page.key)
        .reverse(),
    ]);
    const labels = labelsOf(session);
    expect(labels.slice(0, 12)).toEqual(pagesOf(1, 12).map((page) => `${page.number}л`));
    expect(labels.slice(12)).toEqual(pagesOf(2, 11).map((page) => `${page.number}о`));
  });

  it('12/12 — режим пар: лента как в M3.5, групп нет', () => {
    const assembly = assembleSession(sessionOf([passOf(1, 2), passOf(2, 2)]));

    expect(assembly.report).toMatchObject({ mode: 'pairs', mismatch: false, groups: null });
    expect(assembly.sets).toBeNull();
    expect(assembly.order.map(label)).toEqual(['1л', '1о', '2л', '2о']);
  });

  it.each<[string, SessionSnapshot, 'pairs' | 'sets']>([
    [
      'обороты прерваны и не приняты, 3/1',
      sessionOf([passOf(1, 3), passOf(2, 1, { state: 'interrupted' })]),
      'sets',
    ],
    [
      'обороты приняты коротким, 3/2',
      sessionOf([passOf(1, 3), passOf(2, 2, { state: 'accepted' })]),
      'sets',
    ],
    [
      'проход оборотов идёт, 3/1 — числа ещё меняются',
      sessionOf([passOf(1, 3), passOf(2, 1, { state: 'running' })]),
      'pairs',
    ],
    ['«обороты не нужны»', sessionOf([passOf(1, 3)], { backsDeclined: true }), 'pairs'],
    ['только лицевые', sessionOf([passOf(1, 3)]), 'pairs'],
    [
      'проход оборотов без страниц роли не занимает',
      sessionOf([passOf(1, 3), passOf(2, 0, { state: 'interrupted' })]),
      'pairs',
    ],
    ['оборотов больше, 2/3', sessionOf([passOf(1, 2), passOf(2, 3)]), 'sets'],
  ])('режим по состоянию прохода оборотов: %s', (_name, session, mode) => {
    const { report } = assembleSession(session);

    expect(report.mode).toBe(mode);
    expect(report.mismatch).toBe(mode === 'sets');
  });

  describe('добавленные наборы в группах (AE2)', () => {
    // Лица 1–3, обороты подачей B1 B2 → в ленте B2 B1 (оборот последнего листа — первый).
    const mismatched = [passOf(1, 3), passOf(2, 2)];

    it('якорь — оборот: набор в группе оборотов сразу за якорем; числа уравнены', () => {
      const session = sessionOf([...mismatched, addedOf(3, 1, B(2))]);

      expect(keysOf(session)).toEqual([F(1), F(2), F(3), B(2), keyOf(3, 1), B(1)]);
      expect(labelsOf(session)).toEqual(['1л', '2л', '3л', '1о', 'Д1:2о', '3о']);
      expect(assembleSession(session).sets).toEqual({ fronts: 3, backs: 3, divider: 3 });
    });

    it('якорь — лицо: набор в группе лиц за якорем', () => {
      const session = sessionOf([...mismatched, addedOf(3, 1, F(1))]);

      expect(keysOf(session)).toEqual([F(1), keyOf(3, 1), F(2), F(3), B(2), B(1)]);
      expect(labelsOf(session)).toEqual(['1л', 'Д1:2л', '3л', '4л', '1о', '2о']);
      expect(assembleSession(session).sets).toEqual({ fronts: 4, backs: 2, divider: 4 });
    });

    it.each([
      ['якоря нет', null],
      ['якорь исчез из сессии', 'p09-s01-0001'],
    ])('%s — в конец ленты, то есть в конец группы оборотов', (_name, after) => {
      const session = sessionOf([...mismatched, addedOf(3, 2, after)]);

      expect(keysOf(session)).toEqual([F(1), F(2), F(3), B(2), B(1), keyOf(3, 1), keyOf(3, 2)]);
      expect(assembleSession(session).sets).toEqual({ fronts: 3, backs: 4, divider: 3 });
    });
  });

  it('досканированный сегмент прохода оборотов — последний по подаче, первый в показанной группе', () => {
    const resumed = passOf(2, 0, {
      pages: [...pagesOf(2, 2), { key: 'p02-s02-0001', number: 3, lost: false }],
    });
    const session = sessionOf([passOf(1, 4), resumed]);

    expect(keysOf(session).slice(4)).toEqual(['p02-s02-0001', B(2), B(1)]);
  });

  describe('граница наборов (KTD3)', () => {
    const mismatched = [passOf(1, 3), passOf(2, 2)];

    it('авто — число видимых лиц: удаление лица сдвигает границу', () => {
      const session = sessionOf(mismatched, { edits: { ...EMPTY_EDITS, deleted: [F(2)] } });

      expect(keysOf(session)).toEqual([F(1), F(3), B(2), B(1)]);
      expect(assembleSession(session).sets).toEqual({ fronts: 2, backs: 2, divider: 2 });
    });

    it.each([
      [
        'лицо ушло в обороты',
        2,
        { fronts: 2, backs: 3, divider: 2 },
        ['1л', '2л', '1о', '2о', '3о'],
      ],
      [
        'ноль: все страницы — обороты',
        0,
        { fronts: 0, backs: 5, divider: 0 },
        ['1о', '2о', '3о', '4о', '5о'],
      ],
      [
        'все страницы — лица',
        5,
        { fronts: 5, backs: 0, divider: 5 },
        ['1л', '2л', '3л', '4л', '5л'],
      ],
      [
        'за концом ленты — прижата',
        9,
        { fronts: 5, backs: 0, divider: 5 },
        ['1л', '2л', '3л', '4л', '5л'],
      ],
    ])('явная граница: %s', (_name, divider, sets, labels) => {
      const session = sessionOf(mismatched, { edits: { ...EMPTY_EDITS, divider } });

      expect(assembleSession(session).sets).toEqual(sets);
      expect(labelsOf(session)).toEqual(labels);
    });

    it('перенос через границу с явным порядком: сторона и номер — по группе, не по проходу', () => {
      const session = sessionOf(mismatched, {
        edits: { ...EMPTY_EDITS, order: [F(1), B(2), F(2), F(3), B(1)], divider: 2 },
      });

      expect(keysOf(session)).toEqual([F(1), B(2), F(2), F(3), B(1)]);
      expect(labelsOf(session)).toEqual(['1л', '2л', '1о', '2о', '3о']);
      expect(assembleSession(session)).toMatchObject({ orderEdited: true, hasEdits: true });
    });

    it('граница — правка: «Вернуть» есть что откатывать', () => {
      const session = sessionOf(mismatched, { edits: { ...EMPTY_EDITS, divider: 1 } });

      expect(assembleSession(session)).toMatchObject({ hasEdits: true, orderEdited: false });
    });

    it('поворот 180° — свойство прохода оборотов: оборот в группе лиц повёрнут, «Д1» в оборотах — нет', () => {
      const session = sessionOf(
        [passOf(1, 3), passOf(2, 2, { rotate180: true }), addedOf(3, 1, B(1))],
        { edits: { ...EMPTY_EDITS, divider: 4 } },
      );
      const angles = Object.fromEntries(
        assembleSession(session).order.map((page) => [page.key, [page.side, page.angle]]),
      );

      expect(angles[B(2)]).toEqual(['front', 180]);
      expect(angles[B(1)]).toEqual(['back', 180]);
      expect(angles[keyOf(3, 1)]).toEqual(['back', 0]);
    });
  });

  it('разрезы и имена в режиме наборов не действуют: один документ на всю ленту', () => {
    const session = sessionOf([passOf(1, 3), passOf(2, 2)], {
      edits: { ...EMPTY_EDITS, cuts: [1], names: ['Счёт', 'Акт'] },
    });

    expect(assembleSession(session).documents).toEqual([{ name: '', start: 0, count: 5 }]);
  });
});

describe('сборка: запись сборки (M3.6; R7, KTD4)', () => {
  // Короткие ключи: функции формат ключа безразличен.
  const edits = (extra: Partial<typeof EMPTY_EDITS>) => ({ ...EMPTY_EDITS, ...extra });

  it('AE4, пример из плана: чередование видимых, удалённая — за своим видимым предшественником', () => {
    // Лица 1л 2л Д2 [3л], обороты 1о Д1 3о; 3л удалена; граница — три видимых лица.
    const base = ['1л', '2л', 'Д2', '3л', '1о', 'Д1', '3о'];

    expect(frozenSequenceOf(base, edits({ deleted: ['3л'] }), 3)).toEqual([
      '1л',
      '1о',
      '2л',
      'Д1',
      'Д2',
      '3л',
      '3о',
    ]);
  });

  it('удалённая без видимого предшественника — перед первой страницей', () => {
    const base = ['1л', '2л', 'Д2', '3л', '1о', 'Д1', '3о'];

    expect(frozenSequenceOf(base, edits({ deleted: ['1л'] }), 3)).toEqual([
      '1л',
      '2л',
      '1о',
      'Д2',
      'Д1',
      '3л',
      '3о',
    ]);
  });

  it('несколько удалённых за одним предшественником — в порядке ленты', () => {
    expect(
      frozenSequenceOf(['a', 'b', 'c', 'd', 'x', 'y'], edits({ deleted: ['c', 'b'] }), 2),
    ).toEqual(['a', 'b', 'c', 'x', 'd', 'y']);
  });

  it('удалённая считается по месту в ленте, не по проходу: перенесённая в обороты и удалённая идёт за оборотом', () => {
    // b перенесена в группу оборотов (после x) и удалена: предшественник — x.
    const given = edits({ order: ['a', 'c', 'x', 'b', 'y'], deleted: ['b'] });

    expect(frozenSequenceOf(['a', 'b', 'c', 'x', 'y'], given, 2)).toEqual([
      'a',
      'x',
      'b',
      'c',
      'y',
    ]);
  });

  it('явный порядок — по видимой ленте; неравные группы — остаток в конец', () => {
    expect(
      frozenSequenceOf(['a', 'b', 'c', 'x', 'y', 'z'], edits({ order: ['c', 'a', 'b'] }), 3),
    ).toEqual(['c', 'x', 'a', 'y', 'b', 'z']);
    expect(frozenSequenceOf(['a', 'b', 'c', 'x'], edits({}), 3)).toEqual(['a', 'x', 'b', 'c']);
    expect(frozenSequenceOf(['a', 'b'], edits({}), 0)).toEqual(['a', 'b']);
    expect(frozenSequenceOf([], edits({}), 0)).toEqual([]);
  });
});

describe('сборка: режим «собрано» (M3.6; R6, R11, AE17)', () => {
  // Лица 1–3, обороты 1–2 (в подаче B1 B2); сборка после переноса: 1л 2о 2л 1о 3л.
  const passes = [passOf(1, 3), passOf(2, 2)];
  const RECORD = [F(1), B(2), F(2), B(1), F(3)];
  const assembled = (extra: Partial<SessionSnapshot> = {}): SessionSnapshot =>
    sessionOf(passes, { assembled: RECORD, ...extra });

  it('лента — запись; сторона и лист — по позиции в ней; отчёт без несовпадения', () => {
    const assembly = assembleSession(assembled());

    expect(assembly.report).toMatchObject({ mode: 'assembled', mismatch: false, groups: null });
    expect(assembly.sets).toBeNull();
    expect(assembly.order.map((page) => page.key)).toEqual(RECORD);
    expect(assembly.order.map(label)).toEqual(['1л', '1о', '2л', '2о', '3л']);
    expect(assembly.documents).toEqual([{ name: '', start: 0, count: 5 }]);
  });

  it('удалённая не показана; номера — по видимому чередованию записи; «Вернуть» возвращает её на место', () => {
    const deleted = assembled({ edits: { ...EMPTY_EDITS, deleted: [F(2)] } });

    expect(keysOf(deleted)).toEqual([F(1), B(2), B(1), F(3)]);
    expect(labelsOf(deleted)).toEqual(['1л', '1о', '2л', '2о']);
    expect(keysOf(assembled())).toEqual(RECORD);
  });

  it('мёртвый ключ записи пропущен (чистит коммит; сборка терпима к любому снимку)', () => {
    const session = assembled({ assembled: [F(1), 'p09-s01-0001', B(2), F(2), B(1), F(3)] });

    expect(keysOf(session)).toEqual(RECORD);
    expect(labelsOf(session)).toEqual(['1л', '1о', '2л', '2о', '3л']);
  });

  it('новый добавленный набор после сборки — по якорю, без листа', () => {
    const session = assembled({ passes: [...passes, addedOf(3, 2, B(2))] });

    expect(keysOf(session)).toEqual([F(1), B(2), keyOf(3, 1), keyOf(3, 2), F(2), B(1), F(3)]);
    expect(labelsOf(session).slice(2, 4)).toEqual(['Д1:?л', 'Д1:?л']);
  });

  it('якорь нового набора исчез или его нет — в конец', () => {
    expect(keysOf(assembled({ passes: [...passes, addedOf(3, 1, 'p09-s01-0001')] })).at(-1)).toBe(
      keyOf(3, 1),
    );
    expect(keysOf(assembled({ passes: [...passes, addedOf(3, 1, null)] })).at(-1)).toBe(
      keyOf(3, 1),
    );
  });

  it('досканированный сегмент после сборки — за предыдущей страницей своего прохода, сторона — по проходу', () => {
    const resumed = passOf(2, 0, {
      pages: [...pagesOf(2, 2), { key: 'p02-s02-0001', number: 3, lost: false }],
    });
    const session = assembled({ passes: [passOf(1, 3), resumed] });
    const assembly = assembleSession(session);

    expect(assembly.order.map((page) => page.key)).toEqual([
      F(1),
      B(2),
      'p02-s02-0001',
      F(2),
      B(1),
      F(3),
    ]);
    expect(assembly.order[2]).toMatchObject({ side: 'back', sheet: null, addedSet: null });
  });

  it('ключ без предыдущей страницы прохода в записи — в конец', () => {
    const session = assembled({ assembled: [F(1), B(2), F(2), F(3)] });

    expect(keysOf(session)).toEqual([F(1), B(2), F(2), F(3), B(1)]);
  });

  it('явный порядок поверх записи переставляет ленту, подписи остаются по записи', () => {
    const session = assembled({ edits: { ...EMPTY_EDITS, order: [F(3), F(1)] } });

    expect(keysOf(session)).toEqual([F(3), F(1), B(2), F(2), B(1)]);
    expect(labelsOf(session)).toEqual(['3л', '1л', '1о', '2л', '2о']);
  });

  it('каждая живая страница — ровно один раз в любом режиме', () => {
    const sessions = [
      sessionOf([passOf(1, 3), passOf(2, 2), addedOf(3, 2, B(1))]),
      sessionOf([passOf(1, 3), passOf(2, 2)], { edits: { ...EMPTY_EDITS, divider: 1 } }),
      assembled({ passes: [...passes, addedOf(3, 2, F(2))] }),
      assembled({ assembled: [F(2), 'p09-s01-0001'] }),
    ];
    for (const session of sessions) {
      const alive = session.passes.flatMap((pass) => pass.pages.map((page) => page.key)).sort();
      expect([...keysOf(session)].sort()).toEqual(alive);
    }
  });
});
