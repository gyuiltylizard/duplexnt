import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { EMPTY_EDITS, type Snapshot } from '@shared';
import { blankRatio, type BlankDetector } from '../../src/core/detect/blank';
import type { ScanJobLimits } from '../../src/core/escl/scan-job';
import { type PassServiceOptions } from '../../src/core/scan/pass-service';
import { layoutOf } from '../../src/core/storage/layout';
import { SCENARIOS, type Scenario } from '../emulator/scenarios';
import { connectService, scanned, saveSingle } from '../support/pass-service';
import { pageFixtureOf, pdfPageFixtures } from '../support/fixtures';
import { journalOnDisk, rolesOf } from '../support/session-store';
import { unwrap } from '../support/result';
import { untilScored } from '../support/until';

// Несовпадение оборотов двустороннего добавленного набора на настоящей цепочке (план M4.5, U8; F2,
// AE2, AE3, AE16; R12, R14, R15, R17, R20; KTD3, KTD6): эмулятор `added-pair-mismatch` — основная
// пара 3+3, лица набора «Д1» [7, 8, 9] после оборота листа 2, обороты набора коротким лотком
// [12, 11] (два листа слиплись, проход завершён без ошибки), пятый лоток — полный для «Переснять».
// Проверяется: отчёт `sets` и подблоки по якорю, сохранение не блокируется, «Оставить как есть»
// (durable `kept`, переживает перезапуск), «Переснять обороты набора» (проход, файлы, пометки, кэш
// оценок и правки по мёртвым ключам уходят, разрезы и порядок перебазируются, набор снова ждёт),
// повторное несовпадение, гарды команд решения набора и детектор пустых на оборотах набора. Модалка
// и экраны — `App.pair`.

const FAST: Partial<ScanJobLimits> = {
  retryDelayMs: 5,
  busyCeilingMs: 200,
  notReadyCeilingMs: 2000,
  pageIdleTimeoutMs: 300,
  pageDeadlineMs: 3000,
  deleteDeadlineMs: 300,
};

const OPTIONS = {
  jobLimits: FAST,
  minFreeBytes: 1,
  retry: { ceilingMs: 0 },
} satisfies PassServiceOptions;

const BLANK = 'blank-gray-300';
const MISMATCH = SCENARIOS['added-pair-mismatch'];

/** Ключ страницы `index` (с 1) прохода `pass`, сегмент 1. */
const key = (pass: number, index: number): string =>
  `p${String(pass).padStart(2, '0')}-s01-${String(index).padStart(4, '0')}`;

/** Якорь набора — оборот листа 2 основного документа (подан вторым). */
const ANCHOR = key(2, 2);
/** Основной документ до якоря и после него: лица 1–3, обороты обратным порядком подачи. */
const MAIN_HEAD = [key(1, 1), key(2, 3), key(1, 2), ANCHOR];
const MAIN_TAIL = [key(1, 3), key(2, 1)];
/** Лица набора «Д1» — проход 3; обороты набора — проход 4 (короткий) или 5 (пересъёмка). */
const SET_FRONTS = [key(3, 1), key(3, 2), key(3, 3)];
/** Подблоки несовпавшего набора: лица в порядке сканирования, обороты порядком документа. */
const SUB_BLOCKS = [...SET_FRONTS, key(4, 2), key(4, 1)];
/** Чередование набора из трёх листов по проходу оборотов `pass`: оборот i = `backs[F−1−i]`. */
const interleaved = (pass: number): string[] => [
  key(3, 1),
  key(pass, 3),
  key(3, 2),
  key(pass, 2),
  key(3, 3),
  key(pass, 1),
];

/** Детектор, который записывает, какую фикстуру оценивал. */
function counting() {
  const calls: (number | string)[] = [];
  const detector: BlankDetector = async (bytes, limit) => {
    try {
      calls.push(pageFixtureOf(bytes));
    } catch {
      calls.push('?');
    }
    return blankRatio(bytes, limit);
  };
  return { detector, calls };
}

const sorted = (items: readonly (number | string)[]): string[] => items.map(String).sort();

/** Эмулятор и служба с опциями этого файла (`connectService` в test/support/pass-service.ts). */
const connect = (scenario: Partial<Scenario>, extra: Partial<PassServiceOptions> = {}) =>
  connectService(scenario, OPTIONS, extra);

/** Основная пара 3+3, лица набора после оборота листа 2 и короткие обороты набора: 2 из 3. */
async function mismatched(
  scenario: Partial<Scenario> = MISMATCH,
  extra: Partial<PassServiceOptions> = {},
  hide = false,
) {
  const harness = await connect(scenario, extra);
  const { service } = harness;
  if (hide) {
    unwrap(await service.setBlankMode('hide'));
  }
  await scanned(service, 3, 3);
  expect(unwrap(await service.startPass({ kind: 'addedFronts', after: ANCHOR }))).toMatchObject({
    end: 'completed',
    pages: 3,
  });
  expect(service.snapshot().assembly?.report.pendingSet).toBe(1);
  expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 2 });
  return harness;
}

const keysOf = (snapshot: Snapshot): string[] =>
  snapshot.assembly?.order.map((page) => page.key) ?? [];

/** Страницы набора «Д1» в ленте: ключ, сторона, лист внутри набора. */
const setPagesOf = (snapshot: Snapshot): (string | number | null)[][] =>
  snapshot.assembly?.order
    .filter((page) => page.addedSet === 1)
    .map((page) => [page.key, page.side, page.sheet]) ?? [];

const hiddenOf = (snapshot: Snapshot): string[] =>
  snapshot.assembly?.order.filter((page) => page.blank === 'hidden').map((page) => page.key) ?? [];

const filesOf = async (dir: string, pass: number): Promise<string[]> =>
  (await readdir(dir).catch(() => []))
    .filter((name) => name.startsWith(`p${String(pass).padStart(2, '0')}-`))
    .sort();

const blankDirOf = (root: string, snapshot: Snapshot): string =>
  join(layoutOf(root).derivedDir, snapshot.session?.id ?? '', 'blank');

const conflictOf = (reason: string) => ({
  ok: false,
  error: { code: 'sessionConflict', details: { reason } },
});

/** Отчёт набора «Д1» с несовпавшими оборотами 3/2. */
const MISMATCHED_SET = {
  set: 1,
  fronts: 3,
  backs: 2,
  backsState: 'completed',
  mismatch: true,
  sides: 'two',
} as const;

describe('несовпадение оборотов добавленного набора — через эмулятор (M4.5, U8)', () => {
  it('F2/AE2: обороты набора 2 из 3 — отчёт несовпадения, подблоки по якорю; сохранение не блокируется, PDF подблоками (R20)', async () => {
    const { service, root } = await mismatched();

    const journal = await journalOnDisk(root);
    expect(rolesOf(journal.passes)).toEqual([
      [1, 'fronts', null],
      [2, 'backs', null],
      [3, 'addedFronts', ANCHOR],
      [4, 'addedBacks', null],
    ]);
    expect(journal.passes[2]).toMatchObject({ backsDecision: 'none', pair: null });
    expect(journal.passes[3]).toMatchObject({ pair: 3, backsDecision: null, rotate180: false });

    const snapshot = service.snapshot();
    // Несовпадение живёт в блоке набора: основной документ сошёлся, ожидающего набора нет.
    expect(snapshot.assembly?.report).toMatchObject({
      mode: 'pairs',
      fronts: 3,
      backs: 3,
      mismatch: false,
      pendingSet: null,
    });
    expect(snapshot.assembly?.report.sets).toEqual([{ ...MISMATCHED_SET, decision: 'none' }]);
    expect(keysOf(snapshot)).toEqual([...MAIN_HEAD, ...SUB_BLOCKS, ...MAIN_TAIL]);
    // Подблоки: сторона есть, номер листа не присваивается (R14).
    expect(setPagesOf(snapshot)).toEqual([
      [key(3, 1), 'front', null],
      [key(3, 2), 'front', null],
      [key(3, 3), 'front', null],
      [key(4, 2), 'back', null],
      [key(4, 1), 'back', null],
    ]);

    expect(await pdfPageFixtures(await saveSingle(service, root))).toEqual([
      1, 4, 2, 5, 7, 8, 9, 11, 12, 3, 6,
    ]);
    expect(service.snapshot().session?.saved).toBe(true);
  });

  it('AE2: перезапуск без решения — несовпадение снова ждёт решения; «Оставить как есть» → `kept`, повтор — `setNotMismatched`, после перезапуска `kept`', async () => {
    const { service, root, restart } = await mismatched();
    const order = keysOf(service.snapshot());

    // Без решения модалка положена и после перезапуска (R15): решение `none` с диска.
    const reopened = await restart();
    expect(reopened.snapshot().assembly?.report.sets).toEqual([
      { ...MISMATCHED_SET, decision: 'none' },
    ]);

    expect(await reopened.keepSetBacks(1)).toEqual({ ok: true, value: undefined });
    expect((await journalOnDisk(root)).passes[2]).toMatchObject({
      number: 3,
      kind: 'addedFronts',
      backsDecision: 'kept',
    });
    let snapshot = reopened.snapshot();
    expect(snapshot.assembly?.report.sets).toEqual([{ ...MISMATCHED_SET, decision: 'kept' }]);
    expect(snapshot.assembly?.report.pendingSet).toBeNull();
    // Вывод не меняется: подблоки уже в ленте, страницы и проход оборотов на месте.
    expect(keysOf(snapshot)).toEqual(order);
    expect(await filesOf(layoutOf(root).pagesDir, 4)).toEqual([
      `${key(4, 1)}.jpg`,
      `${key(4, 2)}.jpg`,
    ]);

    // Решение принято — второй раз решать нечего, переснять тоже нельзя.
    expect(await reopened.keepSetBacks(1)).toMatchObject(conflictOf('setNotMismatched'));
    expect(await reopened.rescanSetBacks(1)).toMatchObject(conflictOf('setNotMismatched'));

    const third = await restart();
    snapshot = third.snapshot();
    expect(snapshot.assembly?.report.sets).toEqual([{ ...MISMATCHED_SET, decision: 'kept' }]);
    expect(keysOf(snapshot)).toEqual(order);
    expect(await pdfPageFixtures(await saveSingle(third, root))).toEqual([
      1, 4, 2, 5, 7, 8, 9, 11, 12, 3, 6,
    ]);
  });

  it('AE3: «Переснять обороты набора» — проход, файлы и пометки ушли, правки по мёртвым ключам вычищены, набор снова ждёт; полный лоток → чередование', async () => {
    const { service, root, restart } = await mismatched();
    const pagesDir = layoutOf(root).pagesDir;

    // Правки по ключам отбрасываемого прохода и одна живая; флаг 180° — на проходе оборотов
    // набора. Видимая лента (p04-2 удалён): основной документ до якоря, лица набора, p04-1, хвост.
    // Разрезы перед p04-1 и перед хвостом — средний документ только из оборота набора.
    const edits = {
      ...EMPTY_EDITS,
      rotations: { [key(3, 1)]: 90, [key(4, 1)]: 180 },
      deleted: [key(4, 2)],
      cuts: [7, 8],
      names: ['Начало', 'Обороты', 'Конец'],
    } as const;
    unwrap(await service.setEdits(edits, { 4: true }));
    expect(service.snapshot().session?.edits).toEqual(edits);
    expect((await journalOnDisk(root)).passes[3]).toMatchObject({ number: 4, rotate180: true });
    await saveSingle(service, root);
    expect(service.snapshot().session?.saved).toBe(true);
    expect(await filesOf(pagesDir, 4)).toHaveLength(2);

    expect(await service.rescanSetBacks(1)).toEqual({ ok: true, value: undefined });

    const journal = await journalOnDisk(root);
    expect(rolesOf(journal.passes)).toEqual([
      [1, 'fronts', null],
      [2, 'backs', null],
      [3, 'addedFronts', ANCHOR],
    ]);
    expect(journal.passes[2]?.backsDecision).toBe('none');
    // Удаление доведено: пометок не осталось, файлов прохода нет.
    expect(journal.deletions).toEqual([]);
    expect(journal.saved).toBe(false);
    expect(await filesOf(pagesDir, 4)).toEqual([]);
    expect(await filesOf(pagesDir, 3)).toHaveLength(3);

    let snapshot = service.snapshot();
    expect(snapshot.session?.saved).toBe(false);
    // Мёртвые ключи ушли из поворотов и удалённых; разрез перед p04-1 переехал к следующей
    // уцелевшей странице (хвост) и схлопнулся с разрезом перед ней вместе с именем пустого
    // документа. Живой поворот остался.
    expect(snapshot.session?.edits).toEqual({
      ...EMPTY_EDITS,
      rotations: { [key(3, 1)]: 90 },
      cuts: [7],
      names: ['Начало', 'Конец'],
    });
    expect((await journalOnDisk(root)).edits).toEqual(snapshot.session?.edits);
    expect(snapshot.session?.passes.map((pass) => pass.number)).toEqual([1, 2, 3]);
    expect(snapshot.assembly?.report.pendingSet).toBe(1);
    expect(snapshot.assembly?.report.sets).toEqual([
      {
        set: 1,
        fronts: 3,
        backs: 0,
        backsState: null,
        decision: 'none',
        mismatch: false,
        sides: 'two',
      },
    ]);
    // До оборотов набор — односторонний блок лиц по якорю.
    expect(keysOf(snapshot)).toEqual([...MAIN_HEAD, ...SET_FRONTS, ...MAIN_TAIL]);
    // Флаг 180° отброшенного прохода некуда ставить; решать по ожидающему набору нечего.
    expect(
      await service.setEdits(snapshot.session?.edits ?? EMPTY_EDITS, { 4: true }),
    ).toMatchObject(conflictOf('noBacksPass'));
    expect(await service.keepSetBacks(1)).toMatchObject(conflictOf('noPendingSet'));
    expect(await service.rescanSetBacks(1)).toMatchObject(conflictOf('noPendingSet'));

    // Перезапуск между «Переснять» и оборотами — набор по-прежнему ждёт. Файлы прохода к этому
    // моменту уже удалены, так что усыновлять сверке нечего: окно сбоя между записью журнала и
    // удалением файлов (R22) покрыто юнит-тестом хранилища (session-store.pairs.test.ts).
    const reopened = await restart();
    expect(reopened.snapshot().assembly?.report.pendingSet).toBe(1);
    expect(reopened.snapshot().session?.passes.map((pass) => pass.number)).toEqual([1, 2, 3]);

    // Повторный проход оборотов набора — полный пятый лоток: новый номер прохода, ссылка на лица.
    expect(unwrap(await reopened.startPass(null))).toMatchObject({ end: 'completed', pages: 3 });
    expect((await journalOnDisk(root)).passes.at(-1)).toMatchObject({
      number: 5,
      kind: 'addedBacks',
      pair: 3,
      rotate180: false,
    });
    snapshot = reopened.snapshot();
    expect(snapshot.assembly?.report.sets).toEqual([
      {
        set: 1,
        fronts: 3,
        backs: 3,
        backsState: 'completed',
        decision: 'none',
        mismatch: false,
        sides: 'two',
      },
    ]);
    expect(snapshot.assembly?.report.pendingSet).toBeNull();
    expect(keysOf(snapshot)).toEqual([...MAIN_HEAD, ...interleaved(5), ...MAIN_TAIL]);
    // Автопорядок: чередование; разрез переехал вслед за хвостом основного документа.
    expect(snapshot.session?.edits).toMatchObject({
      order: [],
      cuts: [10],
      names: ['Начало', 'Конец'],
    });
    expect(setPagesOf(snapshot)).toEqual([
      [key(3, 1), 'front', 1],
      [key(5, 3), 'back', 1],
      [key(3, 2), 'front', 2],
      [key(5, 2), 'back', 2],
      [key(3, 3), 'front', 3],
      [key(5, 1), 'back', 3],
    ]);
    // Живая правка пережила пересъёмку; новый проход без флага 180°.
    expect(snapshot.assembly?.order.find((page) => page.key === key(3, 1))?.angle).toBe(90);
    expect(snapshot.assembly?.order.find((page) => page.key === key(5, 1))?.angle).toBe(0);
    expect(await pdfPageFixtures(await saveSingle(reopened, root))).toEqual([
      1, 4, 2, 5, 7, 10, 8, 11, 9, 12, 3, 6,
    ]);
  });

  it('«Переснять» при ручном порядке: мёртвые ключи ушли из `order`, расстановка остальных цела; новые обороты по завершении — чередованием (B-13)', async () => {
    const { service } = await mismatched();

    // Набор «Д1» перенесён в конец ленты целиком: лица, затем обороты.
    const order = [...MAIN_HEAD, ...MAIN_TAIL, ...SET_FRONTS, key(4, 2), key(4, 1)];
    unwrap(await service.setEdits({ ...EMPTY_EDITS, order }, {}));
    expect(keysOf(service.snapshot())).toEqual(order);

    unwrap(await service.rescanSetBacks(1));
    let snapshot = service.snapshot();
    expect(snapshot.session?.edits).toEqual({
      ...EMPTY_EDITS,
      order: [...MAIN_HEAD, ...MAIN_TAIL, ...SET_FRONTS],
    });
    expect(keysOf(snapshot)).toEqual([...MAIN_HEAD, ...MAIN_TAIL, ...SET_FRONTS]);

    // Пока проход шёл, каждый новый оборот вставал за соседом по проходу — подблоком; по
    // завершении ядро расставило обороты за своими лицами (B-13, план 2026-10-27-005, KTD-6).
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 3 });
    snapshot = service.snapshot();
    expect(snapshot.assembly?.report.sets[0]).toMatchObject({ backs: 3, mismatch: false });
    const expected = [
      ...MAIN_HEAD,
      ...MAIN_TAIL,
      key(3, 1),
      key(5, 3),
      key(3, 2),
      key(5, 2),
      key(3, 3),
      key(5, 1),
    ];
    expect(snapshot.session?.edits.order).toEqual(expected);
    expect(keysOf(snapshot)).toEqual(expected);
  });

  it('AE16: повторное несовпадение после «Переснять» — снова решение `none`; «Оставить» → `kept`, после перезапуска решать нечего', async () => {
    // Пятого лотка в сценарии нет: после «Переснять» в лоток снова кладут два листа из трёх.
    const { service, emulator, root, restart } = await mismatched({
      ...MISMATCH,
      trays: MISMATCH.trays.slice(0, 4),
    });
    unwrap(await service.rescanSetBacks(1));
    emulator.reloadTray([12, 11]);
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 2 });

    let snapshot = service.snapshot();
    expect(snapshot.assembly?.report.sets).toEqual([{ ...MISMATCHED_SET, decision: 'none' }]);
    expect(keysOf(snapshot)).toEqual([
      ...MAIN_HEAD,
      ...SET_FRONTS,
      key(5, 2),
      key(5, 1),
      ...MAIN_TAIL,
    ]);
    expect(rolesOf((await journalOnDisk(root)).passes).map(([number]) => number)).toEqual([
      1, 2, 3, 5,
    ]);

    unwrap(await service.keepSetBacks(1));
    expect(service.snapshot().assembly?.report.sets[0]?.decision).toBe('kept');

    const reopened = await restart();
    snapshot = reopened.snapshot();
    expect(snapshot.assembly?.report.sets).toEqual([{ ...MISMATCHED_SET, decision: 'kept' }]);
    expect(snapshot.assembly?.report.pendingSet).toBeNull();
    expect((await journalOnDisk(root)).passes[2]?.backsDecision).toBe('kept');
  });

  it('гарды команд решения набора: неизвестный набор — `noPendingSet`, во время прохода — `passRunning`, во время записи PDF — `saving`; журнал не тронут', async () => {
    const { service, root } = await mismatched();
    const before = await journalOnDisk(root);

    expect(await service.keepSetBacks(2)).toMatchObject(conflictOf('noPendingSet'));
    expect(await service.rescanSetBacks(2)).toMatchObject(conflictOf('noPendingSet'));

    // Запись PDF идёт — решения ждут её конца (KTD-9).
    const folder = join(root, 'выход');
    await mkdir(folder, { recursive: true });
    const saving = service.saveDocuments(folder, {
      mode: 'single',
      names: ['Документ'],
      retry: false,
    });
    expect(await service.keepSetBacks(1)).toMatchObject(conflictOf('saving'));
    expect(await service.rescanSetBacks(1)).toMatchObject(conflictOf('saving'));
    expect(unwrap(await saving).failed).toEqual([]);

    // Идёт проход (односторонний набор в конец, пятый лоток) — решения отклоняются.
    const running = service.startPass({ kind: 'added', after: null });
    expect(service.snapshot().pass).not.toBeNull();
    expect(await service.keepSetBacks(1)).toMatchObject(conflictOf('passRunning'));
    expect(await service.rescanSetBacks(1)).toMatchObject(conflictOf('passRunning'));
    expect(unwrap(await running)).toMatchObject({ end: 'completed', pages: 3 });

    const after = await journalOnDisk(root);
    expect(after.passes.slice(0, 4)).toEqual(before.passes);
    expect(after.passes[2]?.backsDecision).toBe('none');
    expect(after.deletions).toEqual([]);
    expect(await filesOf(layoutOf(root).pagesDir, 4)).toHaveLength(2);
    // Односторонний набор — «Д2»: решать по нему нечего.
    expect(service.snapshot().assembly?.report.sets.map((it) => [it.set, it.sides])).toEqual([
      [1, 'two'],
      [2, 'one'],
    ]);
    expect(await service.keepSetBacks(2)).toMatchObject(conflictOf('noPendingSet'));
  });

  it('сошедшийся набор: «Оставить» и «Переснять» — `setNotMismatched`, проход оборотов цел', async () => {
    const { service, root } = await connect(SCENARIOS['added-pair']);
    await scanned(service, 3, 3);
    unwrap(await service.startPass({ kind: 'addedFronts', after: ANCHOR }));
    unwrap(await service.startPass(null));
    expect(service.snapshot().assembly?.report.sets).toEqual([
      {
        set: 1,
        fronts: 3,
        backs: 3,
        backsState: 'completed',
        decision: 'none',
        mismatch: false,
        sides: 'two',
      },
    ]);

    expect(await service.keepSetBacks(1)).toMatchObject(conflictOf('setNotMismatched'));
    expect(await service.rescanSetBacks(1)).toMatchObject(conflictOf('setNotMismatched'));
    expect(rolesOf((await journalOnDisk(root)).passes).map(([, kind]) => kind)).toEqual([
      'fronts',
      'backs',
      'addedFronts',
      'addedBacks',
    ]);
    expect(keysOf(service.snapshot())).toEqual([...MAIN_HEAD, ...interleaved(4), ...MAIN_TAIL]);
  });

  it('детектор в «Скрывать»: обороты набора оценены (лица — нет), в подблоках пустой скрыт; после «Переснять» — новые по разу, вердикты и пометки отброшенных ушли', async () => {
    const { detector, calls } = counting();
    // Короткий лоток оборотов набора: первым подан пустой оборот листа 3.
    const { service, root } = await mismatched(
      { ...MISMATCH, trays: [...MISMATCH.trays.slice(0, 3), [BLANK, 11], [12, 11, 10]] },
      { blankDetector: detector },
      true,
    );
    await untilScored(() => service.snapshot());

    let snapshot = service.snapshot();
    // Оценки — только оборотам: основного документа и набора, по разу.
    expect(sorted(calls)).toEqual(sorted([6, 5, 4, BLANK, 11]));
    expect(snapshot.assembly?.blank).toEqual({ mode: 'hide', found: 1, hidden: 1, pending: 0 });
    // Подблоки несовпавшего набора: сборки впереди нет — `hide` скрывает (KTD6).
    expect(hiddenOf(snapshot)).toEqual([key(4, 1)]);
    expect(keysOf(snapshot)).toEqual([...MAIN_HEAD, ...SUB_BLOCKS, ...MAIN_TAIL]);
    const blankDir = blankDirOf(root, snapshot);
    expect((await readdir(blankDir)).sort()).toEqual(
      [key(2, 1), key(2, 2), key(2, 3), key(4, 1), key(4, 2)].map((it) => `${it}.json`),
    );

    // «Это не пустая страница» на обороте набора — работает (R17).
    unwrap(await service.setEdits({ ...EMPTY_EDITS, notBlank: [key(4, 1)] }, {}));
    expect(hiddenOf(service.snapshot())).toEqual([]);
    expect(service.snapshot().assembly?.blank).toMatchObject({ found: 0, hidden: 0 });
    // Пометка переезжает на непустой оборот набора: пустой p04-1 снова скрыт и идёт в «Переснять»
    // со своим вердиктом, а пометка лежит на другом ключе отбрасываемого прохода.
    unwrap(await service.setEdits({ ...EMPTY_EDITS, notBlank: [key(4, 2)] }, {}));
    snapshot = service.snapshot();
    expect(hiddenOf(snapshot)).toEqual([key(4, 1)]);
    expect(snapshot.assembly?.blank).toEqual({ mode: 'hide', found: 1, hidden: 1, pending: 0 });

    // После «Переснять» найденный пустой и пометка по мёртвому ключу уходят вместе с проходом.
    unwrap(await service.rescanSetBacks(1));
    snapshot = service.snapshot();
    expect(snapshot.session?.edits.notBlank).toEqual([]);
    expect(snapshot.assembly?.blank).toEqual({ mode: 'hide', found: 0, hidden: 0, pending: 0 });
    expect(hiddenOf(snapshot)).toEqual([]);
    expect((await readdir(blankDir)).sort()).toEqual(
      [key(2, 1), key(2, 2), key(2, 3)].map((it) => `${it}.json`),
    );
    const scoredBefore = calls.length;

    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 3 });
    await untilScored(() => service.snapshot());
    snapshot = service.snapshot();
    expect(sorted(calls.slice(scoredBefore))).toEqual(sorted([12, 11, 10]));
    expect(snapshot.assembly?.blank).toEqual({ mode: 'hide', found: 0, hidden: 0, pending: 0 });
    expect(hiddenOf(snapshot)).toEqual([]);
    expect(snapshot.assembly?.order.every((page) => page.blank === null)).toBe(true);
    expect(keysOf(snapshot)).toEqual([...MAIN_HEAD, ...interleaved(5), ...MAIN_TAIL]);
    expect((await readdir(blankDir)).sort()).toEqual(
      [key(2, 1), key(2, 2), key(2, 3), key(5, 1), key(5, 2), key(5, 3)].map((it) => `${it}.json`),
    );
    // Лица не оценивались ни разу; повторных оценок нет.
    expect(calls.filter((it) => [1, 2, 3, 7, 8, 9].includes(it as number))).toEqual([]);
    await delay(200);
    expect(calls).toHaveLength(scoredBefore + 3);
  }, 20_000);
});
