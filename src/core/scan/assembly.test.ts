import { EMPTY_EDITS, type SessionSnapshot } from '@shared';
import { describe, expect, it } from 'vitest';
import { addedOf, pagesOf, passOf, sessionOf } from '../../../test/support/assembly';
import { assembleSession } from './assembly';

// Табличные тесты правила пар (план M2, U2; KTD-4) и размещения добавленных наборов по якорям
// (план M3.5, U2; KTD-2) — обязательная зона тест-политики: сборка решает, в каком порядке
// страницы лягут в документ, и молча ошибиться здесь нельзя. Режимы M3.6 (раздельные наборы,
// запись сборки, «собрано») — в `assembly.modes.test.ts`.

/** Порядок в читаемом виде: «1л», «1о», …; лишний оборот — «?о»; добавленная — «Д1.2». */
const shape = (session: SessionSnapshot): string[] => {
  const seen = new Map<number, number>();
  return assembleSession(session).order.map((page) => {
    if (page.addedSet === null) {
      return `${page.sheet ?? '?'}${page.side === 'front' ? 'л' : 'о'}`;
    }
    const index = (seen.get(page.addedSet) ?? 0) + 1;
    seen.set(page.addedSet, index);
    return `Д${page.addedSet}.${index}`;
  });
};

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

  // С M3.6 неравные числа при остановленном проходе оборотов — режим раздельных наборов
  // (`assembly.modes.test.ts`); правило пар при недостаче и избытке видно у идущего прохода.
  it('оборотов меньше на один (проход идёт): непарный — лист №1 (младший), пары не съехали', () => {
    const session = sessionOf([passOf(1, 3), passOf(2, 2, { state: 'running' })]);
    const { order, report } = assembleSession(session);

    expect(shape(session)).toEqual(['1л', '2л', '2о', '3л', '3о']);
    expect(order.find((page) => page.side === 'back' && page.sheet === 3)?.key).toBe(
      'p02-s01-0001',
    );
    expect(report).toMatchObject({
      mode: 'pairs',
      pairs: 2,
      unpairedSheets: [1],
      extraBacks: 0,
      mismatch: false,
    });
  });

  it('оборотов не хватает на три: непарные — младшие листы по возрастанию (отчёт по проходам)', () => {
    const session = sessionOf([passOf(1, 5), passOf(2, 2)]);

    expect(assembleSession(session).report.unpairedSheets).toEqual([1, 2, 3]);
  });

  it('оборотов больше (двойной захват, проход идёт): лишние — в конце, не выброшены', () => {
    const session = sessionOf([passOf(1, 2), passOf(2, 3, { state: 'running' })]);
    const { order, report } = assembleSession(session);

    expect(shape(session)).toEqual(['1л', '1о', '2л', '2о', '?о']);
    // Лишний оборот — последняя страница прохода оборотов, лист неизвестен.
    expect(order.at(-1)).toMatchObject({ key: 'p02-s01-0003', side: 'back', sheet: null });
    expect(report).toMatchObject({ pairs: 2, unpairedSheets: [], extraBacks: 1, mismatch: false });
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

  it('проход оборотов прерван и принят коротким: раздельные наборы, состояние в отчёте', () => {
    const session = sessionOf([passOf(1, 3), passOf(2, 1, { state: 'accepted' })]);
    const { report } = assembleSession(session);

    expect(shape(session)).toEqual(['1л', '2л', '3л', '1о']);
    expect(report).toMatchObject({
      mode: 'sets',
      backsState: 'accepted',
      unpairedSheets: [1, 2],
      pairs: 1,
    });
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
  it('роль — `kind`, не номер: после остановки обороты — проход №3', () => {
    const session = sessionOf([passOf(1, 2), passOf(3, 2, { rotate180: true })]);
    const { order, report } = assembleSession(session);

    expect(report.pairs).toBe(2);
    expect(order.filter((page) => page.side === 'back').map((page) => page.key)).toEqual([
      'p03-s01-0002',
      'p03-s01-0001',
    ]);
  });

  it('пустой проход роли не занимает при любом `kind`: лицевые — непустой с ролью', () => {
    const empty = passOf(1, 0, { state: 'interrupted', kind: 'fronts' });
    const session = sessionOf([empty, passOf(2, 2, { kind: 'fronts' }), passOf(3, 2)]);

    expect(shape(session)).toEqual(['1л', '1о', '2л', '2о']);
    // Пустые обороты и пустой добавленный — без роли и места.
    const emptyRoles = sessionOf([
      passOf(1, 2),
      passOf(2, 0, { state: 'interrupted' }),
      addedOf(3, 0, null),
    ]);
    expect(shape(emptyRoles)).toEqual(['1л', '2л']);
    expect(assembleSession(emptyRoles).report).toMatchObject({ backs: 0, backsState: null });
  });

  it('поворот прокидывается только к оборотам; флаг лицевого прохода роли не играет', () => {
    const session = sessionOf([
      passOf(1, 2, { rotate180: true }),
      passOf(2, 2, { rotate180: true }),
    ]);
    const { order } = assembleSession(session);

    expect(order.map((page) => [page.side, page.angle])).toEqual([
      ['front', 0],
      ['back', 180],
      ['front', 0],
      ['back', 180],
    ]);
  });

  it('выключенный поворот — обороты без признака', () => {
    const { order } = assembleSession(sessionOf([passOf(1, 1), passOf(2, 1)]));

    expect(order.every((page) => page.angle === 0)).toBe(true);
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
});

describe('сборка: правки поверх автопорядка (M3, U2)', () => {
  const keysOf = (session: SessionSnapshot): string[] =>
    assembleSession(session).order.map((page) => page.key);

  it('без правок: один документ на всю ленту, флагов правок нет', () => {
    const assembly = assembleSession(sessionOf([passOf(1, 2), passOf(2, 2)]));

    expect(assembly.documents).toEqual([{ name: '', start: 0, count: 4 }]);
    expect(assembly).toMatchObject({ orderEdited: false, hasEdits: false, deleted: 0 });
  });

  it('явный порядок, удаление, угол и разрез — в ленте и документах', () => {
    const session = sessionOf([passOf(1, 3)], {
      edits: {
        order: ['p01-s01-0003', 'p01-s01-0001', 'p01-s01-0002'],
        rotations: { 'p01-s01-0001': 90 },
        deleted: ['p01-s01-0002'],
        cuts: [1],
        names: ['Счёт', 'Акт'],
        divider: null,
      },
    });
    const assembly = assembleSession(session);

    expect(keysOf(session)).toEqual(['p01-s01-0003', 'p01-s01-0001']);
    expect(assembly.order.map((page) => page.angle)).toEqual([0, 90]);
    expect(assembly.documents).toEqual([
      { name: 'Счёт', start: 0, count: 1 },
      { name: 'Акт', start: 1, count: 1 },
    ]);
    expect(assembly).toMatchObject({ orderEdited: true, hasEdits: true, deleted: 1 });
  });

  it('ручной угол складывается с поворотом оборотов по модулю 360', () => {
    const session = sessionOf([passOf(1, 1), passOf(2, 1, { rotate180: true })], {
      edits: { ...EMPTY_EDITS, rotations: { 'p01-s01-0001': 270, 'p02-s01-0001': 270 } },
    });

    expect(assembleSession(session).order.map((page) => page.angle)).toEqual([270, 90]);
  });

  it('включённый поворот оборотов — тоже правка: «Вернуть» его сбрасывает (R8, R9)', () => {
    const session = sessionOf([passOf(1, 1), passOf(2, 1, { rotate180: true })]);

    expect(assembleSession(session)).toMatchObject({ hasEdits: true, orderEdited: false });
  });

  it('отчёт пар считается по проходам: удаление лишнего оборота пометку не снимает (KTD-7)', () => {
    const plain = sessionOf([passOf(1, 3), passOf(2, 1)]);
    const edited = sessionOf([passOf(1, 3), passOf(2, 1)], {
      edits: { ...EMPTY_EDITS, deleted: ['p02-s01-0001'], order: ['p01-s01-0003'] },
    });

    // Группы — живые счётчики ленты (R10), остальной отчёт — о проходах.
    expect(assembleSession(edited).report).toEqual({
      ...assembleSession(plain).report,
      groups: { fronts: 3, backs: 0, divider: 3 },
    });
    expect(assembleSession(edited).report.unpairedSheets).toEqual([1, 2]);
  });

  it('непарность — признак страницы: листы без оборота помечены и после переноса', () => {
    const session = sessionOf([passOf(1, 3), passOf(2, 1)], {
      edits: { ...EMPTY_EDITS, order: ['p01-s01-0002', 'p01-s01-0001'] },
    });
    const flagged = assembleSession(session)
      .order.filter((page) => page.unpaired)
      .map((page) => page.key);

    expect(flagged).toEqual(['p01-s01-0002', 'p01-s01-0001']);
  });

  it('правки с мёртвыми ключами отбрасываются при сборке', () => {
    const session = sessionOf([passOf(1, 2)], {
      edits: {
        order: ['p09-s01-0001', 'p01-s01-0002'],
        rotations: { 'p09-s01-0001': 90 },
        deleted: ['p09-s01-0002'],
        cuts: [],
        names: [''],
        divider: null,
      },
    });
    const assembly = assembleSession(session);

    expect(assembly.order.map((page) => page.key)).toEqual(['p01-s01-0002', 'p01-s01-0001']);
    expect(assembly.deleted).toBe(0);
  });
});

describe('сборка: добавленные наборы по якорям (M3.5, U2; KTD-2)', () => {
  /** Пары 1л 1о 2л 2о 3л 3о: лицевые — проход 1, обороты — проход 2. */
  const pairs = [passOf(1, 3), passOf(2, 3)];
  const F2 = 'p01-s01-0002';

  it('пример из плана целиком: два набора с одним якорем, якорь внутри блока', () => {
    const session = sessionOf([
      ...pairs,
      addedOf(3, 2, F2),
      addedOf(4, 1, F2),
      addedOf(5, 1, 'p03-s01-0002'),
    ]);

    expect(shape(session)).toEqual([
      '1л',
      '1о',
      '2л',
      'Д2.1',
      'Д1.1',
      'Д1.2',
      'Д3.1',
      '2о',
      '3л',
      '3о',
    ]);
  });

  it('тег набора — номер от 1 среди добавленных со страницами, не номер прохода', () => {
    const session = sessionOf([passOf(1, 2), addedOf(4, 1, null), addedOf(7, 1, null)], {
      backsDeclined: true,
    });

    expect(assembleSession(session).order.map((page) => page.addedSet)).toEqual([null, null, 1, 2]);
  });

  it.each([
    ['якорь — лицо при парах', F2, ['1л', '1о', '2л', 'Д1.1', 'Д1.2', '2о', '3л', '3о']],
    ['якорь — оборот', 'p02-s01-0002', ['1л', '1о', '2л', '2о', 'Д1.1', 'Д1.2', '3л', '3о']],
    ['якоря нет (`null`) — в конец', null, ['1л', '1о', '2л', '2о', '3л', '3о', 'Д1.1', 'Д1.2']],
    [
      'якорь исчез из сессии — в конец',
      'p09-s01-0001',
      ['1л', '1о', '2л', '2о', '3л', '3о', 'Д1.1', 'Д1.2'],
    ],
    [
      'якорь — ключ более позднего прохода — в конец',
      'p04-s01-0001',
      ['1л', '1о', '2л', '2о', '3л', '3о', 'Д1.1', 'Д1.2'],
    ],
  ])('%s', (_name, after, expected) => {
    expect(shape(sessionOf([...pairs, addedOf(3, 2, after)]))).toEqual(expected);
  });

  it('якорь удалён правкой — набор за предыдущей видимой; якорь потерян — на месте', () => {
    const deleted = sessionOf([...pairs, addedOf(3, 1, F2)], {
      edits: { ...EMPTY_EDITS, deleted: [F2] },
    });
    expect(shape(deleted)).toEqual(['1л', '1о', 'Д1.1', '2о', '3л', '3о']);

    const lost = sessionOf([
      passOf(1, 3, { pages: pagesOf(1, 3, [2]) }),
      passOf(2, 3),
      addedOf(3, 1, F2),
    ]);
    expect(shape(lost)).toEqual(['1л', '1о', '2л', 'Д1.1', '2о', '3л', '3о']);
    expect(assembleSession(lost).order[2]).toMatchObject({ key: F2, lost: true });
  });

  it('досканированный сегмент — в конец блока своего прохода', () => {
    const resumed = passOf(3, 0, {
      kind: 'added',
      after: F2,
      pages: [
        ...pagesOf(3, 2),
        ...pagesOf(3, 1).map((page) => ({ ...page, key: 'p03-s02-0001', number: 3 })),
      ],
    });
    const session = sessionOf([...pairs, resumed, addedOf(4, 1, F2)]);

    expect(assembleSession(session).order.map((page) => page.key)).toEqual([
      'p01-s01-0001',
      'p02-s01-0003',
      F2,
      'p04-s01-0001',
      'p03-s01-0001',
      'p03-s01-0002',
      'p03-s02-0001',
      'p02-s01-0002',
      'p01-s01-0003',
      'p02-s01-0001',
    ]);
  });

  it('[лицевые, добавленный] при «обороты не нужны»: вне отчёта, несовпадения нет, поворот не ложится', () => {
    const session = sessionOf([passOf(1, 2), addedOf(2, 1, 'p01-s01-0001')], {
      backsDeclined: true,
    });
    const { order, report } = assembleSession(session);

    expect(shape(session)).toEqual(['1л', 'Д1.1', '2л']);
    expect(report).toMatchObject({
      fronts: 2,
      backs: 0,
      pairs: 0,
      mismatch: false,
      backsState: null,
    });
    expect(order.every((page) => page.angle === 0 && !page.unpaired)).toBe(true);

    // Флаг поворота на добавленном проходе роли не играет.
    const flagged = sessionOf([passOf(1, 2), addedOf(2, 1, null, { rotate180: true })], {
      backsDeclined: true,
    });
    expect(assembleSession(flagged).order.map((page) => page.angle)).toEqual([0, 0, 0]);
  });

  it('добавленный при несовпадении проходов: отчёт пар прежний, набор в группе якоря', () => {
    const plain = sessionOf([passOf(1, 3), passOf(2, 2)]);
    const added = sessionOf([passOf(1, 3), passOf(2, 2), addedOf(3, 1, 'p01-s01-0001')]);

    expect(assembleSession(added).report).toEqual({
      ...assembleSession(plain).report,
      groups: { fronts: 4, backs: 2, divider: 4 },
    });
    expect(shape(added)).toEqual(['1л', 'Д1.1', '3л', '4л', '1о', '2о']);
    expect(assembleSession(added).order[0]).toMatchObject({ unpaired: true });
  });

  it('каждая страница — ровно один раз и при добавленных наборах', () => {
    const passes = [
      ...pairs,
      addedOf(3, 2, F2),
      addedOf(4, 1, 'p03-s01-0001'),
      addedOf(5, 1, null),
    ];
    const { order } = assembleSession(sessionOf(passes));

    const expected = passes.flatMap((pass) => pass.pages.map((page) => page.key)).sort();
    expect(order.map((page) => page.key).sort()).toEqual(expected);
  });

  it('«Вернуть» после добавления — набор на месте: правки якорь не трогают', () => {
    const session = sessionOf([...pairs, addedOf(3, 1, F2)], {
      edits: { ...EMPTY_EDITS, order: ['p03-s01-0001', 'p01-s01-0001'] },
    });
    const reverted = { ...session, edits: EMPTY_EDITS };

    expect(shape(session)).toEqual(['Д1.1', '1л', '1о', '2л', '2о', '3л', '3о']);
    expect(shape(reverted)).toEqual(['1л', '1о', '2л', 'Д1.1', '2о', '3л', '3о']);
    expect(assembleSession(reverted)).toMatchObject({ hasEdits: false, orderEdited: false });
  });
});
