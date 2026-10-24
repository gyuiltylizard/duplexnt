import { assert, describe, expect, it } from 'vitest';
import { EMPTY_EDITS, ok as ok2, type SessionEdits, type SessionSnapshot } from '@shared';
import { fsError } from '../../../test/support/intercept-fs';
import {
  isJournalRename,
  ok,
  ORIGIN,
  page,
  rolesOf,
  setup,
} from '../../../test/support/session-store';
import { assembleSession } from '../scan/assembly';

describe('хранилище сессии: флаги журнала v2 (M2, U1)', () => {
  /** Две полных прохода: лицевые (2 стр.) и обороты (2 стр.). */
  async function twoPasses() {
    const context = await setup();
    const { store, accept } = context;
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 2);
    ok(await store.endSegment('completed'));
    ok(await store.beginPass(ORIGIN, null));
    await accept(3, 4);
    ok(await store.endSegment('completed'));
    return context;
  }

  it('тумблер 180° (setEdits) ставит флаг на проход оборотов, идемпотентен, переживает запись', async () => {
    const { store, journalOnDisk } = await twoPasses();

    ok(await store.setEdits(EMPTY_EDITS, { 2: true }));
    ok(await store.setEdits(EMPTY_EDITS, { 2: true }));

    expect(store.snapshot()?.passes.map((pass) => pass.rotate180)).toEqual([false, true]);
    expect((await journalOnDisk()).passes.map((pass) => pass.rotate180)).toEqual([false, true]);

    ok(await store.setEdits(EMPTY_EDITS, {}));
    expect(store.snapshot()?.passes.map((pass) => pass.rotate180)).toEqual([false, false]);
  });

  it('тумблер 180° без прохода оборотов — noBacksPass; без сессии — noSession', async () => {
    const { store, accept } = await setup();

    expect(await store.setEdits(EMPTY_EDITS, { 2: true })).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'noSession' } },
    });

    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 2);
    ok(await store.endSegment('completed'));
    expect(await store.setEdits(EMPTY_EDITS, { 2: true })).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'noBacksPass' } },
    });
  });

  it('роль оборотов — по `kind`, не по номеру: после остановки флаг ложится на проход №3', async () => {
    const { store, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 2);
    ok(await store.endSegment('completed'));
    // Проход оборотов №2 остановлен на первом сегменте: исчезает целиком, номер не переиспользуется.
    ok(await store.beginPass(ORIGIN, null));
    await accept(3, 3);
    expect(ok(await store.discardSegment())).toEqual({ sessionClosed: false });
    expect(ok(await store.beginPass(ORIGIN, null))).toMatchObject({ pass: 3 });
    await accept(4, 5);
    ok(await store.endSegment('completed'));

    ok(await store.setEdits(EMPTY_EDITS, { 3: true }));

    const passes = store.snapshot()?.passes ?? [];
    expect(passes.map((pass) => [pass.number, pass.rotate180])).toEqual([
      [1, false],
      [3, true],
    ]);
  });

  it('declineBacks durable и идемпотентен; с отсканированными оборотами — backsPresent', async () => {
    const { store, accept, journalOnDisk } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 2);
    ok(await store.endSegment('completed'));

    ok(await store.declineBacks());
    ok(await store.declineBacks());

    expect(store.snapshot()?.backsDeclined).toBe(true);
    expect((await journalOnDisk()).backsDeclined).toBe(true);

    const second = await twoPasses();
    expect(await second.store.declineBacks()).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'backsPresent' } },
    });
  });

  it('markSaved ставит отметку; новая страница и смена поворота её снимают (KTD-7)', async () => {
    const { store, accept, journalOnDisk } = await twoPasses();

    ok(await store.markSaved());
    expect(store.snapshot()?.saved).toBe(true);
    expect((await journalOnDisk()).saved).toBe(true);

    // «Сохранил → включил тумблер» — индикация несохранённого возвращается (AE12).
    ok(await store.setEdits(EMPTY_EDITS, { 2: true }));
    expect(store.snapshot()?.saved).toBe(false);

    ok(await store.markSaved());
    ok(await store.beginPass(ORIGIN, null));
    await accept(5, 5);
    expect(store.snapshot()?.saved).toBe(false);
  });

  it('удаление идущего сегмента со страницами снимает отметку о сохранении', async () => {
    const { store, accept } = await twoPasses();
    ok(await store.beginPass(ORIGIN, null));
    await accept(5, 5);
    ok(await store.markSaved());

    ok(await store.discardSegment());

    expect(store.snapshot()?.saved).toBe(false);
  });

  it('markSaved с устаревшей ревизией — no-op: правка во время сохранения не затирается', async () => {
    const { store } = await twoPasses();
    const revision = store.revision();

    // «Пока PDF собирался и писался» — пользователь щёлкнул тумблер поворота.
    ok(await store.setEdits(EMPTY_EDITS, { 2: true }));
    ok(await store.markSaved(revision));

    expect(store.snapshot()?.saved).toBe(false);

    // Свежая ревизия — отметка ставится.
    ok(await store.markSaved(store.revision()));
    expect(store.snapshot()?.saved).toBe(true);
  });

  it('ревизия растёт на каждой правке журнала, включая несохранённую на диск', async () => {
    const { store, accept } = await twoPasses();
    const before = store.revision();

    ok(await store.setEdits(EMPTY_EDITS, { 2: true }));
    expect(store.revision()).toBeGreaterThan(before);

    const afterToggle = store.revision();
    ok(await store.beginPass(ORIGIN, null));
    await accept(5, 5);
    expect(store.revision()).toBeGreaterThan(afterToggle);
  });

  it('новая сессия не наследует флаги закрытой', async () => {
    const { store, accept } = await twoPasses();
    ok(await store.setEdits(EMPTY_EDITS, { 2: true }));
    ok(await store.markSaved());
    ok(await store.closeSession());

    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 1);

    expect(store.snapshot()).toMatchObject({ backsDeclined: false, saved: false });
    expect(store.snapshot()?.passes.map((pass) => pass.rotate180)).toEqual([false]);
  });
});

describe('хранилище сессии: правки редактора (M3, U1)', () => {
  const EDITS: SessionEdits = {
    order: ['p02-s01-0001', 'p01-s01-0001'],
    rotations: { 'p01-s01-0002': 90 },
    deleted: ['p02-s01-0002'],
    cuts: [2],
    names: ['', 'Договор'],
    divider: null,
    notBlank: [],
  };

  async function twoPasses() {
    const context = await setup();
    const { store, accept } = context;
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 2);
    ok(await store.endSegment('completed'));
    ok(await store.beginPass(ORIGIN, null));
    await accept(3, 4);
    ok(await store.endSegment('completed'));
    return context;
  }

  it('правки и поворот оборотов пишутся одной записью журнала и видны в снимке дословно', async () => {
    const { store, calls, journalOnDisk } = await twoPasses();
    const renamesBefore = calls.filter(isJournalRename).length;

    ok(await store.setEdits(EDITS, { 2: true }));

    expect(calls.filter(isJournalRename).length - renamesBefore).toBe(1);
    expect(store.snapshot()?.edits).toEqual(EDITS);
    const journal = await journalOnDisk();
    expect(journal.edits).toEqual(EDITS);
    expect(journal.passes.map((pass) => pass.rotate180)).toEqual([false, true]);
  });

  it('правка снимает отметку «сохранено»; то же состояние повторно — ни записи, ни снятия', async () => {
    const { store, calls } = await twoPasses();
    ok(await store.setEdits(EDITS, {}));
    ok(await store.markSaved());
    const renamesBefore = calls.filter(isJournalRename).length;

    ok(await store.setEdits(EDITS, {}));
    expect(store.snapshot()?.saved).toBe(true);
    expect(calls.filter(isJournalRename).length).toBe(renamesBefore);

    ok(await store.setEdits(EMPTY_EDITS, {}));
    expect(store.snapshot()).toMatchObject({ saved: false, edits: EMPTY_EDITS });
  });

  it('удаление — пометка в правках: файлы на месте, пометки сегментов не трогаются', async () => {
    const { store, pageFiles, journalOnDisk } = await twoPasses();
    const before = await pageFiles();

    ok(await store.setEdits({ ...EMPTY_EDITS, deleted: ['p01-s01-0001', 'p02-s01-0002'] }, {}));

    expect(await pageFiles()).toEqual(before);
    expect((await journalOnDisk()).deletions).toEqual([]);
    expect(ok(await store.readPage('p01-s01-0001'))).toEqual(page(1));
  });

  it('во время прохода правка отклоняется: лента растёт (KTD-9)', async () => {
    const { store, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 2);

    expect(await store.setEdits(EDITS, {})).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'passRunning' } },
    });
    expect(store.snapshot()?.edits).toEqual(EMPTY_EDITS);
  });

  it('без сессии — noSession; поворот без прохода оборотов — noBacksPass, без поворота — можно', async () => {
    const { store, accept } = await setup();
    expect(await store.setEdits(EDITS, {})).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'noSession' } },
    });

    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 2);
    ok(await store.endSegment('completed'));
    expect(await store.setEdits(EMPTY_EDITS, { 2: true })).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'noBacksPass' } },
    });
    const fronts: SessionEdits = { ...EMPTY_EDITS, rotations: { 'p01-s01-0001': 270 } };
    ok(await store.setEdits(fronts, {}));
    expect(store.snapshot()?.edits).toEqual(fronts);
  });

  it('отказ записи журнала — правка не принята, состояние прежнее', async () => {
    let failWrites = false;
    const { store, accept } = await setup((call) => {
      if (failWrites && isJournalRename(call)) {
        throw fsError('EPERM');
      }
    });
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 1);
    ok(await store.endSegment('completed'));
    failWrites = true;

    expect(await store.setEdits(EDITS, {})).toMatchObject({ ok: false });
    expect(store.snapshot()?.edits).toEqual(EMPTY_EDITS);
    expect(store.unsaved()).toBe(false);
  });

  it('новая сессия не наследует правки закрытой', async () => {
    const { store, accept } = await twoPasses();
    ok(await store.setEdits(EDITS, { 2: true }));
    ok(await store.closeSession());

    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 1);

    expect(store.snapshot()?.edits).toEqual(EMPTY_EDITS);
  });

  it('граница наборов (M3.6, R1) пишется в журнал и читается дословно; новая сессия её не наследует', async () => {
    // Проходы 2/1 — режим раздельных наборов; при равных граница обнулилась бы нормализацией.
    const { store, accept, journalOnDisk } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 2);
    ok(await store.endSegment('completed'));
    ok(await store.beginPass(ORIGIN, null));
    await accept(3, 3);
    ok(await store.endSegment('completed'));
    const divided: SessionEdits = { ...EMPTY_EDITS, divider: 1 };

    ok(await store.setEdits(divided, {}));
    expect(store.snapshot()).toMatchObject({ edits: divided, assembled: null });
    expect(await journalOnDisk()).toMatchObject({ edits: divided, assembled: null });

    ok(await store.closeSession());
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 1);

    expect(store.snapshot()).toMatchObject({ edits: EMPTY_EDITS, assembled: null });
  });

  it('досканирование при явном порядке: новый оборот — в группу оборотов, не к лицам (ревью M3.6, #1)', async () => {
    const { store, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 3);
    ok(await store.endSegment('completed'));
    ok(await store.beginPass(ORIGIN, null));
    await accept(4, 4);
    ok(await store.endSegment('interrupted'));
    // Лица переставлены вручную: f2 f1 f3 | b1 — порядок явный.
    const swapped = ['p01-s01-0002', 'p01-s01-0001', 'p01-s01-0003', 'p02-s01-0001'];
    ok(await store.setEdits({ ...EMPTY_EDITS, order: swapped }, {}));

    ok(await store.resumePass());
    await accept(5, 5);
    ok(await store.endSegment('completed'));

    // Пока проход шёл, ключ встал за соседом по проходу — в начало группы оборотов; лица целы.
    const session = store.snapshot();
    assert(session !== null);
    const assembly = assembleSession(session);
    expect(assembly.order.map((page) => page.key)).toEqual([
      'p01-s01-0002',
      'p01-s01-0001',
      'p01-s01-0003',
      'p02-s02-0001',
      'p02-s01-0001',
    ]);
    expect(assembly.sets).toEqual({ fronts: 3, backs: 2, divider: 3 });
  });

  it('досканирование вставило оборот — граница наборов переехала вслед; «Остановить» вернул её (KTD-10; M3.6, R9)', async () => {
    const { store, accept, journalOnDisk } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 3);
    ok(await store.endSegment('completed'));
    // Обороты прерваны на первом: пришёл оборот листа 3. Раздельные наборы: лента f1 f2 f3 | b1;
    // разрезы в этом режиме не живут — вместо них граница; b1 перенесён к лицам (граница 4).
    ok(await store.beginPass(ORIGIN, null));
    await accept(4, 4);
    ok(await store.endSegment('interrupted'));
    ok(await store.setEdits({ ...EMPTY_EDITS, cuts: [2], names: ['', 'Третий'], divider: 4 }, {}));
    expect(store.snapshot()?.edits).toEqual({ ...EMPTY_EDITS, divider: 4 });

    ok(await store.resumePass());
    await accept(5, 5);

    // Оборот листа 2 лёг в начало группы оборотов: f1 f2 f3 b2 b1 — граница в конце осталась в конце.
    expect(store.snapshot()?.edits).toMatchObject({ divider: 5 });
    expect((await journalOnDisk()).edits.divider).toBe(5);

    ok(await store.discardSegment());
    expect(store.snapshot()?.edits).toMatchObject({ divider: 4 });
  });

  it('правка нормализуется перед записью: разрез перед первой позицией снят, мёртвый ключ вычищен', async () => {
    const { store, journalOnDisk } = await twoPasses();

    ok(
      await store.setEdits(
        {
          order: [],
          rotations: { 'p09-s01-0001': 90, 'p01-s01-0001': 180 },
          deleted: [],
          cuts: [0, 2],
          names: ['Пусто', 'Начало', 'Конец'],
          divider: null,
          notBlank: [],
        },
        {},
      ),
    );

    const expected: SessionEdits = {
      order: [],
      rotations: { 'p01-s01-0001': 180 },
      deleted: [],
      cuts: [2],
      names: ['Начало', 'Конец'],
      divider: null,
      notBlank: [],
    };
    expect(store.snapshot()?.edits).toEqual(expected);
    expect((await journalOnDisk()).edits).toEqual(expected);
  });

  it('состояние, которое нормализуется к записанному, — не правка: «сохранено» не снимается', async () => {
    const { store } = await twoPasses();
    ok(await store.setEdits({ ...EMPTY_EDITS, cuts: [2], names: ['', 'Б'] }, {}));
    ok(await store.markSaved());

    ok(await store.setEdits({ ...EMPTY_EDITS, cuts: [0, 2], names: ['', '', 'Б'] }, {}));

    expect(store.snapshot()?.saved).toBe(true);
  });

  it('досканирование при ручном порядке: новые страницы на своём месте по автопорядку, разрез — перед той же страницей (KTD-3, замена AE9 M3)', async () => {
    const { store, accept, journalOnDisk } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 2);
    ok(await store.endSegment('interrupted'));
    const manual: SessionEdits = {
      ...EMPTY_EDITS,
      order: ['p01-s01-0002', 'p01-s01-0001'],
      cuts: [1],
      names: ['', 'Хвост'],
    };
    ok(await store.setEdits(manual, {}));

    ok(await store.resumePass());
    await accept(3, 4);
    ok(await store.endSegment('completed'));

    // Предшественник новых страниц по автопорядку — p01-s01-0002, первая в ручном порядке.
    const expected: SessionEdits = {
      ...manual,
      order: ['p01-s01-0002', 'p01-s02-0001', 'p01-s02-0002', 'p01-s01-0001'],
      cuts: [3],
    };
    const session = store.snapshot();
    expect(session?.edits).toEqual(expected);
    expect((await journalOnDisk()).edits).toEqual(expected);
    const assembly = assembleSession(session ?? assert.fail('сессии нет'));
    expect(assembly.documents.map((doc) => [doc.name, doc.count])).toEqual([
      ['', 3],
      ['Хвост', 1],
    ]);
    expect(assembly.orderEdited).toBe(true);
  });

  it('добавленный набор при ручном порядке и разрезе: за якорем в его документе, без шага правки (KTD-2, KTD-3)', async () => {
    const { store, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 3);
    ok(await store.endSegment('completed'));
    ok(await store.declineBacks());
    // Лента 3 1 | 2: документ А = {3, 1}, Б = {2}.
    const manual: SessionEdits = {
      ...EMPTY_EDITS,
      order: ['p01-s01-0003', 'p01-s01-0001', 'p01-s01-0002'],
      cuts: [2],
      names: ['А', 'Б'],
    };
    ok(await store.setEdits(manual, {}));

    ok(await store.beginPass(ORIGIN, { kind: 'added', after: 'p01-s01-0001' }));
    await accept(4, 5);
    ok(await store.endSegment('completed'));

    const session = store.snapshot();
    expect(session?.edits).toEqual({
      ...manual,
      order: ['p01-s01-0003', 'p01-s01-0001', 'p02-s01-0001', 'p02-s01-0002', 'p01-s01-0002'],
      cuts: [4],
    });
    const assembly = assembleSession(session ?? assert.fail('сессии нет'));
    expect(assembly.order.map((page) => [page.key, page.addedSet])).toEqual([
      ['p01-s01-0003', null],
      ['p01-s01-0001', null],
      ['p02-s01-0001', 1],
      ['p02-s01-0002', 1],
      ['p01-s01-0002', null],
    ]);
    expect(assembly.documents.map((doc) => [doc.name, doc.count])).toEqual([
      ['А', 4],
      ['Б', 1],
    ]);
  });

  it('углы в другом порядке ключей — не правка: «сохранено» не снимается', async () => {
    const { store } = await twoPasses();
    const rotations = { 'p01-s01-0001': 90, 'p02-s01-0001': 180 } as const;
    ok(await store.setEdits({ ...EMPTY_EDITS, rotations }, {}));
    ok(await store.markSaved());

    ok(
      await store.setEdits(
        { ...EMPTY_EDITS, rotations: { 'p02-s01-0001': 180, 'p01-s01-0001': 90 } },
        {},
      ),
    );

    expect(store.snapshot()?.saved).toBe(true);
  });
});

describe('хранилище сессии: роль прохода и добавленные наборы (M3.5, U1)', () => {
  const ADDED = { kind: 'added', after: null } as const;
  const roles = (store: { snapshot(): SessionSnapshot | null }) =>
    rolesOf(store.snapshot()?.passes ?? []);

  /** Ключи видимой ленты — как её собирает ядро. */
  const visibleKeys = (store: { snapshot(): SessionSnapshot | null }): string[] => {
    const session = store.snapshot();
    assert(session !== null);
    return assembleSession(session).order.map((page) => page.key);
  };

  /** Лицевые (2 стр.) завершены. */
  async function fronts() {
    const context = await setup();
    const { store, accept } = context;
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 2);
    ok(await store.endSegment('completed'));
    return context;
  }

  it('проходы по очереди получают роли лицевых и оборотов; с намерением — добавленный с якорем', async () => {
    const { store, accept, journalOnDisk } = await fronts();
    ok(await store.beginPass(ORIGIN, null));
    await accept(3, 4);
    ok(await store.endSegment('completed'));

    ok(await store.beginPass(ORIGIN, { kind: 'added', after: 'p01-s01-0001' }));
    await accept(5, 5);
    ok(await store.endSegment('completed'));

    const expected = [
      [1, 'fronts', null],
      [2, 'backs', null],
      [3, 'added', 'p01-s01-0001'],
    ];
    expect(roles(store)).toEqual(expected);
    expect(rolesOf((await journalOnDisk()).passes)).toEqual(expected);
  });

  it('без намерения при лицевых и оборотах или при отказе от оборотов — добавленный без якоря', async () => {
    const { store, accept } = await fronts();
    ok(await store.beginPass(ORIGIN, null));
    await accept(3, 4);
    ok(await store.endSegment('completed'));
    ok(await store.beginPass(ORIGIN, null));
    await accept(5, 5);
    ok(await store.endSegment('completed'));
    expect(roles(store).at(-1)).toEqual([3, 'added', null]);

    const declined = await fronts();
    ok(await declined.store.declineBacks());
    ok(await declined.store.beginPass(ORIGIN, null));
    await declined.accept(3, 3);
    expect(roles(declined.store)).toEqual([
      [1, 'fronts', null],
      [2, 'added', null],
    ]);
  });

  it('добавленный набор без сессии — noSession; якорь не из сессии — invalidInput; сеть и диск не тронуты', async () => {
    const { store, calls, pageFiles } = await setup();

    expect(await store.beginPass(ORIGIN, ADDED)).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'noSession' } },
    });
    expect(calls).toEqual([]);

    const { store: withFronts, journalOnDisk } = await fronts();
    const before = await journalOnDisk();
    expect(
      await withFronts.beginPass(ORIGIN, { kind: 'added', after: 'p01-s01-0009' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalidInput', details: { field: 'after' } },
    });
    expect(
      await withFronts.beginPass(ORIGIN, { kind: 'added', after: 'p02-s01-0001' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalidInput' },
    });
    expect(await journalOnDisk()).toEqual(before);
    expect(await pageFiles()).toEqual([]);
  });

  it('тумблер 180° при [лицевые, добавленный] — noBacksPass; «обороты не нужны» — успех', async () => {
    const { store, accept } = await fronts();
    ok(await store.beginPass(ORIGIN, ADDED));
    await accept(3, 3);
    ok(await store.endSegment('completed'));

    expect(await store.setEdits(EMPTY_EDITS, { 2: true })).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'noBacksPass' } },
    });
    ok(await store.declineBacks());
    expect(store.snapshot()?.backsDeclined).toBe(true);
  });

  it('пустой прерванный проход оборотов роли не занимает: «обороты не нужны» проходит, тумблер — noBacksPass', async () => {
    const { store } = await fronts();
    // Сбой до первой страницы: сегмент оборотов прерван с нулём страниц и остался в журнале.
    ok(await store.beginPass(ORIGIN, null));
    ok(await store.endSegment('interrupted'));
    expect(roles(store)).toEqual([
      [1, 'fronts', null],
      [2, 'backs', null],
    ]);

    expect(await store.setEdits(EMPTY_EDITS, { 2: true })).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'noBacksPass' } },
    });
    ok(await store.declineBacks());
    expect(store.snapshot()?.backsDeclined).toBe(true);
    // Пустой прерванный проход оборотов ушёл вместе с отказом: досканировать нечего, добавлять
    // можно сразу.
    expect(roles(store)).toEqual([[1, 'fronts', null]]);
    expect(store.resumeTarget()).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'notInterrupted' } },
    });
    expect(store.planPass(null)).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'backsDeclined' } },
    });
    expect(store.planPass(ADDED)).toMatchObject({ ok: true, value: { kind: 'added' } });
  });

  it('«Остановить» на первом сегменте добавленного набора убирает проход; лента и правки прежние', async () => {
    const { store, accept, journalOnDisk } = await fronts();
    const edits: SessionEdits = {
      order: ['p01-s01-0002', 'p01-s01-0001'],
      rotations: { 'p01-s01-0001': 90 },
      deleted: [],
      cuts: [1],
      names: ['', 'Акт'],
      divider: null,
      notBlank: [],
    };
    ok(await store.setEdits(edits, {}));
    const keysBefore = visibleKeys(store);

    ok(await store.beginPass(ORIGIN, { kind: 'added', after: 'p01-s01-0001' }));
    await accept(3, 4);
    expect(ok(await store.discardSegment())).toEqual({ sessionClosed: false });

    expect(roles(store)).toEqual([[1, 'fronts', null]]);
    expect(store.snapshot()?.edits).toEqual(edits);
    expect((await journalOnDisk()).edits).toEqual(edits);
    expect(visibleKeys(store)).toEqual(keysBefore);
  });

  it('новая страница добавленного набора снимает отметку о сохранении', async () => {
    const { store, accept } = await fronts();
    ok(await store.markSaved());
    expect(store.snapshot()?.saved).toBe(true);

    ok(await store.beginPass(ORIGIN, ADDED));
    await accept(3, 3);

    expect(store.snapshot()?.saved).toBe(false);
  });
});

describe('хранилище сессии: политика запуска planPass (M3.5, U3; KTD-5)', () => {
  const ADDED = { kind: 'added', after: null } as const;

  it('пустая сессия — лицевые; после лицевых — обороты с «из M»; после отказа — backsDeclined', async () => {
    const { store, accept } = await setup();
    expect(store.planPass(null)).toEqual(
      ok2({ kind: 'fronts', resumed: false, expected: null, pair: null }),
    );

    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 3);
    ok(await store.endSegment('completed'));
    expect(store.planPass(null)).toEqual(
      ok2({ kind: 'backs', resumed: false, expected: 3, pair: null }),
    );

    ok(await store.declineBacks());
    expect(store.planPass(null)).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'backsDeclined' } },
    });
    // Добавленный набор отказ от оборотов не держит.
    expect(store.planPass(ADDED)).toEqual(
      ok2({ kind: 'added', resumed: false, expected: null, pair: null }),
    );
  });

  it('при лицевых и оборотах — backsPresent без намерения, added с намерением', async () => {
    const { store, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 2);
    ok(await store.endSegment('completed'));
    ok(await store.beginPass(ORIGIN, null));
    await accept(3, 4);
    ok(await store.endSegment('completed'));

    expect(store.planPass(null)).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'backsPresent' } },
    });
    expect(store.planPass({ kind: 'added', after: 'p02-s01-0001' })).toEqual(
      ok2({ kind: 'added', resumed: false, expected: null, pair: null }),
    );
    expect(store.planPass({ kind: 'added', after: 'p09-s01-0001' })).toMatchObject({
      ok: false,
      error: { code: 'invalidInput', details: { field: 'after' } },
    });
  });

  it('прерванный последний проход: без намерения — досканирование той же роли, с намерением — passInterrupted', async () => {
    const { store, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 3);
    ok(await store.endSegment('completed'));
    ok(await store.beginPass(ORIGIN, null));
    await accept(4, 4);
    ok(await store.endSegment('interrupted'));

    expect(store.planPass(null)).toEqual(
      ok2({ kind: 'backs', resumed: true, expected: 3, pair: null }),
    );
    expect(store.planPass(ADDED)).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'passInterrupted' } },
    });

    ok(await store.acceptPass());
    expect(store.planPass(ADDED)).toEqual(
      ok2({ kind: 'added', resumed: false, expected: null, pair: null }),
    );
    // Прерванный добавленный досканируется без «из M».
    ok(await store.beginPass(ORIGIN, ADDED));
    await accept(5, 5);
    ok(await store.endSegment('interrupted'));
    expect(store.planPass(null)).toEqual(
      ok2({ kind: 'added', resumed: true, expected: null, pair: null }),
    );
  });

  it('без сессии добавлять не к чему; идущий проход — passRunning', async () => {
    const { store, accept } = await setup();
    expect(store.planPass(ADDED)).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'noSession' } },
    });
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 1);
    expect(store.planPass(null)).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'passRunning' } },
    });
  });
});

describe('хранилище сессии: режим пустых оборотов (M4, U3; ADR 0004, амендмент 2026-10-22)', () => {
  it('замораживается при первом проходе, второй проход его не меняет, переживает запись', async () => {
    const { store, accept, journalOnDisk } = await setup();
    ok(await store.beginPass(ORIGIN, null, 'hide'));
    await accept(1, 2);
    ok(await store.endSegment('completed'));
    ok(await store.beginPass(ORIGIN, null, 'keep'));
    await accept(3, 4);
    ok(await store.endSegment('completed'));

    expect(store.snapshot()?.blankMode).toBe('hide');
    expect((await journalOnDisk()).blankMode).toBe('hide');
  });

  it('без аргумента — «оставлять»; новая сессия после закрытия замораживает заново', async () => {
    const { store, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 1);
    ok(await store.endSegment('completed'));
    expect(store.snapshot()?.blankMode).toBe('keep');
    ok(await store.closeSession());

    ok(await store.beginPass(ORIGIN, null, 'mark'));
    await accept(1, 1);
    ok(await store.endSegment('completed'));
    expect(store.snapshot()?.blankMode).toBe('mark');
  });

  it('проход без страниц сессию не открывает: следующий проход замораживает режим заново', async () => {
    const { store, accept, journalOnDisk } = await setup();
    ok(await store.beginPass(ORIGIN, null, 'hide'));
    ok(await store.endSegment('completed'));
    expect(store.snapshot()).toBeNull();

    ok(await store.beginPass(ORIGIN, null, 'mark'));
    await accept(1, 1);
    ok(await store.endSegment('completed'));
    expect(store.snapshot()?.blankMode).toBe('mark');
    expect((await journalOnDisk()).blankMode).toBe('mark');
  });

  it('пометки «не пустая» пишутся в журнал и читаются дословно; мёртвые и повторные ключи вычищены', async () => {
    const { store, accept, journalOnDisk } = await setup();
    ok(await store.beginPass(ORIGIN, null, 'hide'));
    await accept(1, 2);
    ok(await store.endSegment('completed'));
    ok(await store.beginPass(ORIGIN, null));
    await accept(3, 4);
    ok(await store.endSegment('completed'));

    ok(
      await store.setEdits(
        { ...EMPTY_EDITS, notBlank: ['p02-s01-0002', 'p02-s01-0002', 'p09-s01-0001'] },
        {},
      ),
    );

    expect(store.snapshot()?.edits.notBlank).toEqual(['p02-s01-0002']);
    expect((await journalOnDisk()).edits.notBlank).toEqual(['p02-s01-0002']);
    // Та же пометка повторно — не правка: «сохранено» не снимается.
    ok(await store.markSaved());
    ok(await store.setEdits({ ...EMPTY_EDITS, notBlank: ['p02-s01-0002'] }, {}));
    expect(store.snapshot()?.saved).toBe(true);
  });
});
