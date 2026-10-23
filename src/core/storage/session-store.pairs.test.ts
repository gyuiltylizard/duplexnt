import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_EDITS, ok as okOf, type SessionEdits } from '@shared';
import { fsError, type FsCall } from '../../../test/support/intercept-fs';
import { ok, ORIGIN, rolesOf, setup } from '../../../test/support/session-store';
import { pendingPairOf } from './journal';
import { blankDirOf } from './layout';
import { openSessionStore } from './reconcile';

// Пара добавленного набора в хранилище (M4.5, U2): очередь оборотов набора, решения по оборотам
// («Обороты не нужны», «Оставить как есть», «Переснять»), принятие коротких оборотов, карта
// флагов 180°. Остальные флаги и правки — `session-store.flags.test.ts`.

const SESSION = 'a1b2c3d4e5f60718';
const TWO_SIDED = { kind: 'addedFronts', after: 'p01-s01-0002' } as const;
const ONE_SIDED = { kind: 'added', after: null } as const;
const conflict = (reason: string) => ({
  ok: false,
  error: { code: 'sessionConflict', details: { reason } },
});

type Context = Awaited<ReturnType<typeof setup>>;

/** Основная пачка: лицевые (2 стр.) и обороты (2 стр.) завершены. */
async function mainPack(before?: (call: FsCall) => void): Promise<Context> {
  const context = await setup(before);
  const { store, accept } = context;
  ok(await store.beginPass(ORIGIN, null));
  await accept(1, 2);
  ok(await store.endSegment('completed'));
  ok(await store.beginPass(ORIGIN, null));
  await accept(3, 4);
  ok(await store.endSegment('completed'));
  return context;
}

/** Лица набора «Д1» (проход 3) из `count` страниц — завершены. */
async function setFronts({ store, accept }: Context, count = 2): Promise<void> {
  ok(await store.beginPass(ORIGIN, TWO_SIDED));
  await accept(5, 4 + count);
  ok(await store.endSegment('completed'));
}

/** Обороты набора по очереди (проход 4) из `count` страниц с исходом `outcome`. */
async function setBacks(
  { store, accept }: Context,
  count: number,
  outcome: 'completed' | 'interrupted' = 'completed',
): Promise<void> {
  ok(await store.beginPass(ORIGIN, null));
  await accept(11, 10 + count);
  ok(await store.endSegment(outcome));
}

describe('хранилище сессии: очередь пары добавленного набора (M4.5, R4, R7, R11)', () => {
  it('лица набора пишутся с решением «ждём»; обороты набора — по очереди со ссылкой пары и «из F»', async () => {
    const context = await mainPack();
    const { store, journalOnDisk } = context;
    await setFronts(context);

    expect((await journalOnDisk()).passes[2]).toMatchObject({
      kind: 'addedFronts',
      after: 'p01-s01-0002',
      pair: null,
      backsDecision: 'none',
    });
    expect(store.planPass(null)).toEqual(
      okOf({ kind: 'addedBacks', resumed: false, expected: 2, pair: 3 }),
    );

    await setBacks(context, 2);

    expect((await journalOnDisk()).passes[3]).toMatchObject({
      kind: 'addedBacks',
      after: null,
      pair: 3,
      backsDecision: null,
      rotate180: false,
    });
    expect(store.snapshot()?.passes[3]).toMatchObject({ kind: 'addedBacks', pair: 3 });
    expect(store.planPass(null)).toEqual(conflict('backsPresent'));
    expect(pendingPairOf(await journalOnDisk())).toBeNull();
  });

  it('пока набор ждёт обороты, новый набор не начинается; «Остановить» на оборотах набора до первой страницы возвращает ожидание', async () => {
    const context = await mainPack();
    const { store, journalOnDisk } = context;
    await setFronts(context);

    expect(await store.beginPass(ORIGIN, ONE_SIDED)).toEqual(conflict('pairPending'));
    expect(await store.beginPass(ORIGIN, TWO_SIDED)).toEqual(conflict('pairPending'));

    ok(await store.beginPass(ORIGIN, null));
    expect(ok(await store.discardSegment())).toEqual({ sessionClosed: false });

    expect(rolesOf((await journalOnDisk()).passes)).toEqual([
      [1, 'fronts', null],
      [2, 'backs', null],
      [3, 'addedFronts', 'p01-s01-0002'],
    ]);
    expect(store.planPass(null)).toEqual(
      okOf({ kind: 'addedBacks', resumed: false, expected: 2, pair: 3 }),
    );
    // Номер отброшенного прохода не переиспользуется.
    expect(ok(await store.beginPass(ORIGIN, null))).toMatchObject({ pass: 5 });
  });

  it('двусторонний набор в режиме раздельных наборов — pairInSets; односторонний проходит (R3)', async () => {
    const { store, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 3);
    ok(await store.endSegment('completed'));
    ok(await store.beginPass(ORIGIN, null));
    await accept(4, 5);
    ok(await store.endSegment('completed'));

    expect(store.planPass(TWO_SIDED)).toEqual(conflict('pairInSets'));
    expect(await store.beginPass(ORIGIN, TWO_SIDED)).toEqual(conflict('pairInSets'));
    expect(store.planPass(ONE_SIDED)).toMatchObject({ ok: true, value: { kind: 'added' } });
  });
});

describe('хранилище сессии: решения по оборотам набора (M4.5, R6, R15; KTD3)', () => {
  it('«Обороты не нужны» при ожидающем наборе пишет declined на его лица, флаг сессии не трогает; пустой прерванный проход оборотов набора уходит', async () => {
    const context = await mainPack();
    const { store, journalOnDisk } = context;
    await setFronts(context);
    // Обороты набора прерваны до первой страницы (сбой подачи).
    ok(await store.beginPass(ORIGIN, null));
    ok(await store.endSegment('interrupted'));

    ok(await store.declineBacks());

    const journal = await journalOnDisk();
    expect(journal.passes.map((pass) => [pass.number, pass.backsDecision])).toEqual([
      [1, null],
      [2, null],
      [3, 'declined'],
    ]);
    expect(journal.backsDeclined).toBe(false);
    expect(pendingPairOf(journal)).toBeNull();
    expect(store.planPass(null)).toEqual(conflict('backsPresent'));
    // Без ожидающего набора команда адресуется сессии: обороты основной пачки есть.
    expect(await store.declineBacks()).toEqual(conflict('backsPresent'));
  });

  it('«Оставить как есть» — только при несовпадении и «ждём»; иначе setNotMismatched; без набора или оборотов — noPendingSet', async () => {
    const context = await mainPack();
    const { store, journalOnDisk } = context;
    await setFronts(context, 3);

    expect(await store.keepSetBacks(1)).toEqual(conflict('noPendingSet'));
    await setBacks(context, 2);

    ok(await store.keepSetBacks(1));
    expect((await journalOnDisk()).passes[2]?.backsDecision).toBe('kept');
    expect(await store.keepSetBacks(1)).toEqual(conflict('setNotMismatched'));
    expect(await store.keepSetBacks(2)).toEqual(conflict('noPendingSet'));

    // Односторонний набор «Д2» решений по оборотам не имеет.
    ok(await store.beginPass(ORIGIN, ONE_SIDED));
    await context.accept(20, 20);
    ok(await store.endSegment('completed'));
    expect(await store.keepSetBacks(2)).toEqual(conflict('noPendingSet'));
  });

  it('«Оставить как есть» при совпавших оборотах набора — setNotMismatched', async () => {
    const context = await mainPack();
    await setFronts(context, 2);
    await setBacks(context, 2);

    expect(await context.store.keepSetBacks(1)).toEqual(conflict('setNotMismatched'));
  });

  it('решения по набору при прерванных оборотах — passInterrupted: сначала досканировать или «Оставить как есть» в плашке (U8)', async () => {
    const context = await mainPack();
    const { store, journalOnDisk } = context;
    await setFronts(context, 3);
    await setBacks(context, 2, 'interrupted');
    const before = await journalOnDisk();

    expect(await store.keepSetBacks(1)).toEqual(conflict('passInterrupted'));
    expect(await store.rescanSetBacks(1)).toEqual(conflict('passInterrupted'));
    expect(await journalOnDisk()).toEqual(before);
  });

  it('принятие пустого прерванного прохода оборотов набора не ставит kept: набор ждёт дальше, очередь даёт новые обороты (ревью)', async () => {
    const context = await mainPack();
    const { store, journalOnDisk } = context;
    await setFronts(context, 3);
    ok(await store.beginPass(ORIGIN, null));
    ok(await store.endSegment('interrupted'));

    ok(await store.acceptPass());

    expect((await journalOnDisk()).passes[2]?.backsDecision).toBe('none');
    expect(pendingPairOf(await journalOnDisk())).toEqual({ set: 1, fronts: 3, expected: 3 });
    expect(store.planPass(null)).toEqual(
      okOf({ kind: 'addedBacks', resumed: false, expected: 3, pair: 3 }),
    );
  });

  it('принятие прерванных оборотов набора: короткие → kept, полные → «ждём» остаётся (AE11)', async () => {
    const short = await mainPack();
    await setFronts(short, 3);
    await setBacks(short, 2, 'interrupted');
    ok(await short.store.acceptPass());
    expect((await short.journalOnDisk()).passes[2]?.backsDecision).toBe('kept');

    const full = await mainPack();
    await setFronts(full, 2);
    await setBacks(full, 2, 'interrupted');
    ok(await full.store.acceptPass());
    expect((await full.journalOnDisk()).passes[2]?.backsDecision).toBe('none');
  });
});

describe('хранилище сессии: «Переснять обороты набора» (M4.5, R15; KTD3; ADR 0004, амендмент 2026-10-23)', () => {
  const EDITS: SessionEdits = {
    ...EMPTY_EDITS,
    order: ['p04-s01-0002', 'p01-s01-0001'],
    rotations: { 'p04-s01-0002': 90, 'p01-s01-0001': 180 },
    deleted: ['p04-s01-0001'],
    notBlank: ['p04-s01-0002'],
  };

  it('проход оборотов исчезает из журнала и с диска вместе с кэшем оценок и правками по его ключам; набор снова ждёт обороты', async () => {
    const context = await mainPack();
    const { store, layout, pageFiles, journalOnDisk } = context;
    await setFronts(context, 3);
    await setBacks(context, 2);
    ok(await store.setEdits(EDITS, { 4: true }));
    ok(await store.markSaved());
    const blank = blankDirOf(layout, SESSION);
    await mkdir(blank, { recursive: true });
    await writeFile(join(blank, 'p04-s01-0001.json'), '{"v":1,"ratio":0}');
    await writeFile(join(blank, 'p02-s01-0001.json'), '{"v":1,"ratio":0}');

    ok(await store.rescanSetBacks(1));

    const journal = await journalOnDisk();
    expect(rolesOf(journal.passes)).toEqual([
      [1, 'fronts', null],
      [2, 'backs', null],
      [3, 'addedFronts', 'p01-s01-0002'],
    ]);
    expect(journal).toMatchObject({ deletions: [], saved: false });
    // Мёртвые ключи вычищены нормализацией без шага undo; живые правки остались.
    expect(journal.edits).toEqual({
      ...EMPTY_EDITS,
      order: ['p01-s01-0001'],
      rotations: { 'p01-s01-0001': 180 },
    });
    expect((await pageFiles()).filter((name) => name.startsWith('p04-'))).toEqual([]);
    expect(await readdir(blank)).toEqual(['p02-s01-0001.json']);
    expect(pendingPairOf(journal)).toEqual({ set: 1, fronts: 3, expected: 3 });
    expect(store.planPass(null)).toEqual(
      okOf({ kind: 'addedBacks', resumed: false, expected: 3, pair: 3 }),
    );
    expect(await store.rescanSetBacks(1)).toEqual(conflict('noPendingSet'));

    // Новые обороты набора — новая пара с новым номером прохода.
    await setBacks(context, 3);
    expect(rolesOf((await journalOnDisk()).passes).at(-1)).toEqual([5, 'addedBacks', null]);
    expect((await journalOnDisk()).passes[3]).toMatchObject({ pair: 3 });
    expect(await store.keepSetBacks(1)).toEqual(conflict('setNotMismatched'));
  });

  it('после «оставить как есть» или при совпадении переснимать нечего', async () => {
    const context = await mainPack();
    await setFronts(context, 3);
    await setBacks(context, 2);
    ok(await context.store.keepSetBacks(1));

    expect(await context.store.rescanSetBacks(1)).toEqual(conflict('setNotMismatched'));
  });

  it('сбой удаления файла после записи журнала: пометка остаётся, страницы не выдаются, сверка при запуске дочищает', async () => {
    const context = await mainPack((call) => {
      if (call.op === 'unlink' && call.path.includes('p04-s01-0001.jpg')) {
        throw fsError('EBUSY');
      }
    });
    const { store, root, pageFiles, journalOnDisk } = context;
    await setFronts(context, 3);
    await setBacks(context, 2);

    ok(await store.rescanSetBacks(1));

    expect((await journalOnDisk()).deletions).toEqual(['p04-s01-']);
    expect(await pageFiles()).toContain('p04-s01-0001.jpg');
    expect(store.snapshot()?.passes.map((pass) => pass.number)).toEqual([1, 2, 3]);
    expect(await store.readPage('p04-s01-0001')).toMatchObject({ ok: false });

    const { store: reopened } = await openSessionStore(root);

    expect((await pageFiles()).filter((name) => name.startsWith('p04-'))).toEqual([]);
    expect((await journalOnDisk()).deletions).toEqual([]);
    expect(reopened.planPass(null)).toEqual(
      okOf({ kind: 'addedBacks', resumed: false, expected: 3, pair: 3 }),
    );
  });
});

describe('хранилище сессии: карта флагов 180° по проходам оборотов (M4.5, R16; KTD4)', () => {
  it('флаги пишутся на обороты основной пачки и набора по номеру прохода; не названные — false; пустая карта сбрасывает все', async () => {
    const context = await mainPack();
    const { store, journalOnDisk } = context;
    await setFronts(context, 2);
    await setBacks(context, 2);
    const flags = () => store.snapshot()?.passes.map((pass) => pass.rotate180);

    ok(await store.setEdits(EMPTY_EDITS, { 2: true, 4: true }));
    expect(flags()).toEqual([false, true, false, true]);
    expect((await journalOnDisk()).passes.map((pass) => pass.rotate180)).toEqual([
      false,
      true,
      false,
      true,
    ]);

    ok(await store.setEdits(EMPTY_EDITS, { 4: true }));
    expect(flags()).toEqual([false, false, false, true]);

    ok(await store.setEdits(EMPTY_EDITS, {}));
    expect(flags()).toEqual([false, false, false, false]);
  });

  it('номер не прохода оборотов — лицевых, лиц набора, отсутствующий — noBacksPass без частичной записи', async () => {
    const context = await mainPack();
    const { store } = context;
    await setFronts(context, 2);
    await setBacks(context, 2);

    for (const bad of [{ 1: true }, { 3: true }, { 9: true }, { 2: true, 3: true }]) {
      expect(await store.setEdits(EMPTY_EDITS, bad)).toEqual(conflict('noBacksPass'));
    }
    expect(store.snapshot()?.passes.map((pass) => pass.rotate180)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});
