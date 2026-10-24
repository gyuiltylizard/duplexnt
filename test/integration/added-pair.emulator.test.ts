import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_EDITS, type Snapshot } from '@shared';
import { blankRatio, type BlankDetector } from '../../src/core/detect/blank';
import type { ScanJobLimits } from '../../src/core/escl/scan-job';
import { type PassService, type PassServiceOptions } from '../../src/core/scan/pass-service';
import { layoutOf } from '../../src/core/storage/layout';
import { SCENARIOS, type Scenario } from '../emulator/scenarios';
import { connectService, scanned } from '../support/pass-service';
import { pageFixture, pageFixtureOf, pdfImageStreams } from '../support/fixtures';
import { journalOnDisk, rolesOf } from '../support/session-store';
import { unwrap } from '../support/result';
import { untilScored } from '../support/until';

// Двусторонний добавленный набор — полный путь на настоящей цепочке (план M4.5, U8; R3, R4,
// R6–R8, R11, R12, R16, R17, R21, R22): эмулятор с лотками по заданиям → служба с намерением
// `addedFronts` → журнал v7 (роли пары, `pair`, `backsDecision`) → ожидание оборотов набора в
// отчёте → обороты набора по очереди без намерения → блок с чередованием по якорю → PDF →
// перезапуск между проходами пары. Здесь — совпадение, отказ от оборотов набора, отказы
// намерений (`pairPending`, `pairInSets`), режим «собрано» (AE13), флаг 180° по проходам (AE6) и
// отказ флага на одностороннем наборе (AE15), детектор на оборотах набора и пустой оборот набора
// при «Скрывать» (R17, AE7), журнал v6 (AE10). Несовпадение, обрыв и «Остановить» —
// `added-pair-mismatch.emulator.test.ts`. Сценарии эмулятора — те же, что у `npm run emulator` и
// CDP-смоука.

const FAST: Partial<ScanJobLimits> = {
  retryDelayMs: 5,
  busyCeilingMs: 200,
  notReadyCeilingMs: 2000,
  pageIdleTimeoutMs: 300,
  pageDeadlineMs: 3000,
  deleteDeadlineMs: 300,
};

const BLANK = 'blank-gray-300';

const OPTIONS = {
  jobLimits: FAST,
  minFreeBytes: 1,
  retry: { ceilingMs: 0 },
} satisfies PassServiceOptions;

// Основная пара 3+3: лица 1–3, обороты обратным порядком подачи (первый — оборот листа 3).
const F1 = 'p01-s01-0001';
const F2 = 'p01-s01-0002';
const F3 = 'p01-s01-0003';
/** Оборот листа `sheet` основного документа из 3 листов: подан `4 − sheet`-м. */
const B = (sheet: number): string => `p02-s01-000${String(4 - sheet)}`;
/** Лицо `sheet` набора и оборот, поданный `fed`-м, — проходы `fronts` и `backs` пары. */
const setFront = (fronts: number, sheet: number): string =>
  `p0${String(fronts)}-s01-000${String(sheet)}`;
const setBack = (backs: number, fed: number): string => `p0${String(backs)}-s01-000${String(fed)}`;

/** Блок пары из 3 листов с чередованием: оборот листа i — страница F−1−i прохода оборотов. */
const pairBlock = (fronts: number, backs: number): string[] => [
  setFront(fronts, 1),
  setBack(backs, 3),
  setFront(fronts, 2),
  setBack(backs, 2),
  setFront(fronts, 3),
  setBack(backs, 1),
];

/** Лента AE1: набор «после стр. 4» (оборот листа 2 основного документа). */
const AE1_ORDER = [F1, B(1), F2, B(2), ...pairBlock(3, 4), F3, B(3)];
const AE1_FIXTURES = [1, 4, 2, 5, 7, 10, 8, 11, 9, 12, 3, 6];

/** Эмулятор и служба с опциями этого файла (`connectService` в test/support/pass-service.ts). */
const connect = (scenario: Partial<Scenario>, extra: Partial<PassServiceOptions> = {}) =>
  connectService(scenario, OPTIONS, extra);

/** Основная пара 3+3 и лица набора после оборота листа 2 — набор ждёт обороты. */
async function setFrontsScanned(service: PassService): Promise<void> {
  await scanned(service, 3, 3);
  expect(unwrap(await service.startPass({ kind: 'addedFronts', after: B(2) }))).toMatchObject({
    end: 'completed',
    pages: 3,
  });
}

const keysOf = (snapshot: Snapshot): string[] =>
  snapshot.assembly?.order.map((page) => page.key) ?? [];

/** Набор, сторона и лист каждой страницы ленты: «1л», «Д1:2о», «Д1:?л» (лист не присвоен). */
const shapeOf = (snapshot: Snapshot): string[] =>
  snapshot.assembly?.order.map(
    (page) =>
      `${page.addedSet === null ? '' : `Д${String(page.addedSet)}:`}${String(page.sheet ?? '?')}${
        page.side === 'back' ? 'о' : 'л'
      }`,
  ) ?? [];

/** Угол каждой страницы ленты по ключу. */
const anglesOf = (snapshot: Snapshot): Record<string, number> =>
  Object.fromEntries(snapshot.assembly?.order.map((page) => [page.key, page.angle]) ?? []);

/** Роли проходов подряд без повторов — по снимкам идущего прохода. */
const kindsSeen = (snapshots: readonly Snapshot[]): string[] =>
  snapshots
    .map((it) => it.pass?.kind)
    .filter((kind): kind is NonNullable<typeof kind> => kind !== undefined)
    .filter((kind, index, all) => index === 0 || all[index - 1] !== kind);

/** Побайтовая сверка видимой ленты с ожидаемыми фикстурами. */
async function expectAssembledFixtures(
  root: string,
  snapshot: Snapshot,
  fixtures: readonly number[],
): Promise<void> {
  const order = snapshot.assembly?.order ?? [];
  expect(order).toHaveLength(fixtures.length);
  for (const [index, page] of order.entries()) {
    const written = await readFile(join(layoutOf(root).pagesDir, `${page.key}.jpg`));
    expect(written.equals(pageFixture(fixtures[index] ?? 0)), `позиция ${index + 1}`).toBe(true);
  }
}

/** Запись одним файлом после прихода оценок; фикстуры страниц PDF по порядку (номер или скан). */
async function savedFixtures(service: PassService, root: string): Promise<(number | string)[]> {
  const folder = join(root, 'выход');
  await mkdir(folder, { recursive: true });
  await untilScored(() => service.snapshot());
  const saved = unwrap(
    await service.saveDocuments(folder, { mode: 'single', names: ['Документ'], retry: false }),
  );
  expect(saved.failed).toEqual([]);
  // Повторная запись в ту же папку получает « (2)» — читаем фактическое имя.
  expect(saved.written).toHaveLength(1);
  const file = join(folder, saved.written[0]?.fileName ?? '');
  const streams = await pdfImageStreams(await readFile(file));
  return streams.map((stream) => pageFixtureOf(stream.contents));
}

describe('двусторонний добавленный набор — полный путь через эмулятор (M4.5, U8)', () => {
  it('F1 / AE1: основная пара → лица набора «после стр. 4» → ожидание → обороты «из 3» → чередование по якорю → журнал v7 → PDF', async () => {
    const { service, root, snapshots } = await connect(SCENARIOS['added-pair']);
    await setFrontsScanned(service);

    // Между проходами пары: набор ждёт обороты (экран `flip` набора), лица стоят блоком по якорю.
    let snapshot = service.snapshot();
    expect(snapshot.pass).toBeNull();
    expect(snapshot.assembly?.report).toMatchObject({
      mode: 'pairs',
      pendingSet: 1,
      fronts: 3,
      backs: 3,
      mismatch: false,
    });
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
    expect(keysOf(snapshot)).toEqual([
      F1,
      B(1),
      F2,
      B(2),
      setFront(3, 1),
      setFront(3, 2),
      setFront(3, 3),
      F3,
      B(3),
    ]);
    let journal = await journalOnDisk(root);
    expect(journal.passes.at(-1)).toMatchObject({
      number: 3,
      kind: 'addedFronts',
      after: B(2),
      pair: null,
      backsDecision: 'none',
    });

    // Обороты набора — без намерения, по очереди (R4, R11).
    const before = snapshots.length;
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 3 });

    // Экраны по `pass.kind`: `scan` лиц, `scan` оборотов, `scan` лиц набора, `scan` оборотов
    // набора; лица набора — без «из M», обороты набора — «из 3» лиц набора.
    expect(kindsSeen(snapshots)).toEqual(['fronts', 'backs', 'addedFronts', 'addedBacks']);
    const setFrontsRun = snapshots.map((it) => it.pass).filter((it) => it?.kind === 'addedFronts');
    expect(setFrontsRun.every((pass) => pass?.expected === null && !pass.resumed)).toBe(true);
    const setBacksRun = snapshots
      .slice(before)
      .map((it) => it.pass)
      .filter((it) => it !== null);
    expect(setBacksRun.length).toBeGreaterThan(0);
    expect(
      setBacksRun.every(
        (pass) => pass.kind === 'addedBacks' && pass.expected === 3 && !pass.resumed,
      ),
    ).toBe(true);

    journal = await journalOnDisk(root);
    expect(journal.version).toBe(7);
    expect(rolesOf(journal.passes)).toEqual([
      [1, 'fronts', null],
      [2, 'backs', null],
      [3, 'addedFronts', B(2)],
      [4, 'addedBacks', null],
    ]);
    expect(journal.passes.map((pass) => [pass.pair, pass.backsDecision])).toEqual([
      [null, null],
      [null, null],
      [null, 'none'],
      [3, null],
    ]);
    expect(journal.backsDeclined).toBe(false);

    snapshot = service.snapshot();
    expect(snapshot.assembly?.report).toMatchObject({ mode: 'pairs', pendingSet: null });
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
    expect(keysOf(snapshot)).toEqual(AE1_ORDER);
    expect(shapeOf(snapshot)).toEqual([
      '1л',
      '1о',
      '2л',
      '2о',
      'Д1:1л',
      'Д1:1о',
      'Д1:2л',
      'Д1:2о',
      'Д1:3л',
      'Д1:3о',
      '3л',
      '3о',
    ]);
    expect(snapshot.assembly?.order.every((page) => page.angle === 0 && !page.lost)).toBe(true);
    await expectAssembledFixtures(root, snapshot, AE1_FIXTURES);

    // PDF повторяет ленту: 1л, 1о, 2л, 2о набора — после стр. 4.
    expect(await savedFixtures(service, root)).toEqual(AE1_FIXTURES);
    expect(service.snapshot().session?.saved).toBe(true);
    // Очередь исчерпана: новый проход без намерения не начинается.
    expect(await service.startPass(null)).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'backsPresent' } },
    });
  });

  it('F3 / AE4, R8, R11: перезапуск между проходами пары — набор ждёт; новое намерение отклонено (`pairPending`); запуск без намерения — обороты набора', async () => {
    const { service, root, snapshots, restart } = await connect(SCENARIOS['added-pair']);
    await setFrontsScanned(service);

    // Пока набор ждёт, новый набор любого вида не начинается — до сети, журнал не тронут.
    const journalBefore = await journalOnDisk(root);
    expect(journalBefore.passes).toHaveLength(3);
    for (const kind of ['added', 'addedFronts'] as const) {
      expect(await service.startPass({ kind, after: F1 })).toMatchObject({
        ok: false,
        error: { code: 'sessionConflict', details: { reason: 'pairPending' } },
      });
    }
    expect(await journalOnDisk(root)).toEqual(journalBefore);

    const second = await restart();
    let snapshot = second.snapshot();
    expect(snapshot.assembly?.report.pendingSet).toBe(1);
    expect(snapshot.assembly?.report.sets[0]).toMatchObject({
      set: 1,
      fronts: 3,
      backs: 0,
      decision: 'none',
      sides: 'two',
    });
    expect(snapshot.canResume).toBe(false);
    expect(await second.startPass({ kind: 'added', after: null })).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'pairPending' } },
    });
    expect(await journalOnDisk(root)).toEqual(journalBefore);

    const before = snapshots.length;
    expect(unwrap(await second.startPass(null))).toMatchObject({ end: 'completed', pages: 3 });
    const running = snapshots
      .slice(before)
      .map((it) => it.pass)
      .filter((it) => it !== null);
    expect(running.length).toBeGreaterThan(0);
    expect(
      running.every((pass) => pass.kind === 'addedBacks' && pass.expected === 3 && !pass.resumed),
    ).toBe(true);

    snapshot = second.snapshot();
    expect(snapshot.assembly?.report.pendingSet).toBeNull();
    expect(snapshot.assembly?.report.sets[0]).toMatchObject({
      backs: 3,
      backsState: 'completed',
      mismatch: false,
    });
    expect(keysOf(snapshot)).toEqual(AE1_ORDER);
    expect((await journalOnDisk(root)).passes.at(-1)).toMatchObject({
      number: 4,
      kind: 'addedBacks',
      pair: 3,
    });
    expect(await savedFixtures(second, root)).toEqual(AE1_FIXTURES);
  });

  it('F3 / AE5: «Обороты не нужны» для набора — `declined` на лицах, набор односторонним блоком; очередь не зовёт его обороты; перезапуск помнит; следующий набор — Д2', async () => {
    const { service, root, restart } = await connect({
      ...SCENARIOS['added-pair-declined'],
      trays: [...SCENARIOS['added-pair-declined'].trays, [13, 14]],
    });
    await setFrontsScanned(service);

    expect(await service.declineBacks()).toEqual({ ok: true, value: undefined });

    // Отказ — набору, не сессии: флаг основной пачки не тронут.
    let journal = await journalOnDisk(root);
    expect(journal.backsDeclined).toBe(false);
    expect(journal.passes.map((pass) => [pass.kind, pass.backsDecision])).toEqual([
      ['fronts', null],
      ['backs', null],
      ['addedFronts', 'declined'],
    ]);
    let snapshot = service.snapshot();
    expect(snapshot.session?.backsDeclined).toBe(false);
    expect(snapshot.assembly?.report.pendingSet).toBeNull();
    expect(snapshot.assembly?.report.sets).toEqual([
      {
        set: 1,
        fronts: 3,
        backs: 0,
        backsState: null,
        decision: 'declined',
        mismatch: false,
        sides: 'two',
      },
    ]);
    const declinedOrder = [F1, B(1), F2, B(2), setFront(3, 1), setFront(3, 2), setFront(3, 3)];
    expect(keysOf(snapshot)).toEqual([...declinedOrder, F3, B(3)]);
    expect(
      snapshot.assembly?.order
        .filter((page) => page.addedSet === 1)
        .map((page) => [page.side, page.angle]),
    ).toEqual([
      ['front', 0],
      ['front', 0],
      ['front', 0],
    ]);

    // Без намерения проходу браться неоткуда: обороты основной пачки есть, набор решён.
    expect(await service.startPass(null)).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'backsPresent' } },
    });
    expect((await journalOnDisk(root)).passes).toHaveLength(3);
    expect(await savedFixtures(service, root)).toEqual([1, 4, 2, 5, 7, 8, 9, 3, 6]);

    // Перезапуск: отказ на месте, `flip` набора не возвращается.
    const second = await restart();
    snapshot = second.snapshot();
    expect(snapshot.assembly?.report.pendingSet).toBeNull();
    expect(snapshot.assembly?.report.sets[0]).toMatchObject({ decision: 'declined', backs: 0 });
    expect(await second.startPass(null)).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'backsPresent' } },
    });

    // `pairPending` снят: следующий двусторонний набор — «Д2», ждёт свои обороты «из 2».
    expect(unwrap(await second.startPass({ kind: 'addedFronts', after: null }))).toMatchObject({
      end: 'completed',
      pages: 2,
    });
    snapshot = second.snapshot();
    expect(snapshot.assembly?.report.pendingSet).toBe(2);
    expect(snapshot.assembly?.report.sets.map((it) => [it.set, it.fronts, it.decision])).toEqual([
      [1, 3, 'declined'],
      [2, 2, 'none'],
    ]);
    journal = await journalOnDisk(root);
    expect(rolesOf(journal.passes).at(-1)).toEqual([4, 'addedFronts', null]);
  });

  it('R3 / AE13: в режиме раздельных наборов двусторонний отклонён (`pairInSets`), односторонний — как в M3.6; после «Собрать документ» пара встаёт блоком с чередованием по якорю', async () => {
    const { service, root } = await connect({
      trays: [[1, 2, 3], [6, 4], [5], [7, 8, 9], [12, 11, 10]],
    });
    await scanned(service, 3, 2);
    expect(service.snapshot().assembly?.report.mode).toBe('sets');

    // Обороты [6, 4]: первым подан оборот листа 3, вторым — листа 1.
    const backOf3 = 'p02-s01-0001';
    const backOf1 = 'p02-s01-0002';
    const added = 'p03-s01-0001';
    expect(await service.startPass({ kind: 'addedFronts', after: F1 })).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'pairInSets' } },
    });
    expect((await journalOnDisk(root)).passes).toHaveLength(2);

    // Недостающий оборот листа 2 — односторонним набором, затем «Собрать документ».
    expect(unwrap(await service.startPass({ kind: 'added', after: backOf1 }))).toMatchObject({
      end: 'completed',
      pages: 1,
    });
    unwrap(await service.assemble());
    const record = [F1, backOf1, F2, added, F3, backOf3];
    expect(service.snapshot().session?.assembled).toEqual(record);

    // AE13: в «собрано» двусторонний доступен; блок пары — по якорю, запись сборки не тронута.
    expect(unwrap(await service.startPass({ kind: 'addedFronts', after: added }))).toMatchObject({
      end: 'completed',
      pages: 3,
    });
    expect(service.snapshot().assembly?.report.pendingSet).toBe(2);
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 3 });

    const snapshot = service.snapshot();
    expect(snapshot.session?.assembled).toEqual(record);
    expect(snapshot.assembly?.report).toMatchObject({
      mode: 'assembled',
      pendingSet: null,
      mismatch: false,
    });
    expect(snapshot.assembly?.report.sets).toEqual([
      {
        set: 1,
        fronts: 1,
        backs: 0,
        backsState: null,
        decision: null,
        mismatch: false,
        sides: 'one',
      },
      {
        set: 2,
        fronts: 3,
        backs: 3,
        backsState: 'completed',
        decision: 'none',
        mismatch: false,
        sides: 'two',
      },
    ]);
    expect(keysOf(snapshot)).toEqual([F1, backOf1, F2, added, ...pairBlock(4, 5), F3, backOf3]);
    expect(shapeOf(snapshot).slice(4, 10)).toEqual([
      'Д2:1л',
      'Д2:1о',
      'Д2:2л',
      'Д2:2о',
      'Д2:3л',
      'Д2:3о',
    ]);
    const fixtures = [1, 4, 2, 5, 7, 10, 8, 11, 9, 12, 3, 6];
    await expectAssembledFixtures(root, snapshot, fixtures);
    expect(await savedFixtures(service, root)).toEqual(fixtures);

    // AE15 (ядро): флаг 180° на одностороннем «Д1» (проход 3, `added`) — не обороты: команда
    // отклонена целиком, флаги журнала и углы ленты прежние — и одна, и вместе с флагом пары.
    unwrap(await service.setEdits(EMPTY_EDITS, { 5: true }));
    const flags = (await journalOnDisk(root)).passes.map((pass) => pass.rotate180);
    expect(flags).toEqual([false, false, false, false, true]);
    const angles = anglesOf(service.snapshot());
    expect(pairBlock(4, 5).map((key) => angles[key])).toEqual([0, 180, 0, 180, 0, 180]);
    for (const map of [{ 3: true }, { 3: true, 5: true }]) {
      expect(await service.setEdits(EMPTY_EDITS, map)).toMatchObject({
        ok: false,
        error: { code: 'sessionConflict', details: { reason: 'noBacksPass' } },
      });
      expect((await journalOnDisk(root)).passes.map((pass) => pass.rotate180)).toEqual(flags);
      expect(anglesOf(service.snapshot())).toEqual(angles);
    }
  });

  it('AE6: флаг 180° — картой по проходам: обороты набора крутятся порознь с основными; лица флага не принимают', async () => {
    const { service, root } = await connect(SCENARIOS['added-pair']);
    await setFrontsScanned(service);
    await scanned(service, 3);
    const setBacks = [setBack(4, 1), setBack(4, 2), setBack(4, 3)];
    const mainBacks = [B(1), B(2), B(3)];
    const fronts = [F1, F2, F3, setFront(3, 1), setFront(3, 2), setFront(3, 3)];

    // Тумблер на обороте листа 2 набора — крутит только обороты «Д1».
    unwrap(await service.setEdits(EMPTY_EDITS, { 4: true }));
    let angles = anglesOf(service.snapshot());
    expect(setBacks.map((key) => angles[key])).toEqual([180, 180, 180]);
    expect([...mainBacks, ...fronts].every((key) => angles[key] === 0)).toBe(true);
    let journal = await journalOnDisk(root);
    expect(journal.passes.map((pass) => pass.rotate180)).toEqual([false, false, false, true]);
    expect(service.snapshot().assembly?.hasEdits).toBe(true);

    // Карта с одним основным флагом — не названный проход набора возвращается к `false`.
    unwrap(await service.setEdits(EMPTY_EDITS, { 2: true }));
    angles = anglesOf(service.snapshot());
    expect(mainBacks.map((key) => angles[key])).toEqual([180, 180, 180]);
    expect([...setBacks, ...fronts].every((key) => angles[key] === 0)).toBe(true);
    journal = await journalOnDisk(root);
    expect(journal.passes.map((pass) => pass.rotate180)).toEqual([false, true, false, false]);

    // Полная карта — как её шлёт renderer, когда перевёрнуты обе пачки: все 6 оборотов на 180°,
    // лица на месте, флаг — у каждого прохода оборотов отдельно.
    unwrap(await service.setEdits(EMPTY_EDITS, { 2: true, 4: true }));
    angles = anglesOf(service.snapshot());
    expect([...mainBacks, ...setBacks].map((key) => angles[key])).toEqual([
      180, 180, 180, 180, 180, 180,
    ]);
    expect(fronts.every((key) => angles[key] === 0)).toBe(true);
    journal = await journalOnDisk(root);
    expect(journal.passes.map((pass) => pass.rotate180)).toEqual([false, true, false, true]);

    // Проход лиц набора — не обороты: команда отклонена целиком, флаги и углы прежние.
    expect(await service.setEdits(EMPTY_EDITS, { 2: true, 3: true })).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'noBacksPass' } },
    });
    journal = await journalOnDisk(root);
    expect(journal.passes.map((pass) => pass.rotate180)).toEqual([false, true, false, true]);
    expect(anglesOf(service.snapshot())).toEqual(angles);

    // «Вернуть» — пустая карта: все обороты на месте.
    unwrap(await service.setEdits(EMPTY_EDITS, {}));
    expect(service.snapshot().assembly?.order.every((page) => page.angle === 0)).toBe(true);
    expect(service.snapshot().assembly?.hasEdits).toBe(false);
  });

  it('R17: «Скрывать» — детектор оценивает обороты набора по разу, лица набора не оценивает; кэш оценок только по оборотам', async () => {
    const calls: number[] = [];
    const detector: BlankDetector = async (bytes, limit) => {
      calls.push(bytes.byteLength);
      return blankRatio(bytes, limit);
    };
    const { service, root } = await connect(SCENARIOS['added-pair'], { blankDetector: detector });
    unwrap(await service.setBlankMode('hide'));
    await setFrontsScanned(service);
    await scanned(service, 3);
    await untilScored(() => service.snapshot());

    const snapshot = service.snapshot();
    expect(snapshot.assembly?.blank).toEqual({ mode: 'hide', found: 0, hidden: 0, pending: 0 });
    expect(calls).toHaveLength(6);
    const blankDir = join(layoutOf(root).derivedDir, snapshot.session?.id ?? '', 'blank');
    expect((await readdir(blankDir)).sort()).toEqual(
      [B(3), B(2), B(1), setBack(4, 1), setBack(4, 2), setBack(4, 3)].map((key) => `${key}.json`),
    );
    expect(keysOf(snapshot)).toEqual(AE1_ORDER);
  });

  it('AE7: «Скрывать» — пустой оборот листа 2 набора скрыт, лист за ним сохранён; «Это не пустая страница» возвращает его в ленту и PDF', async () => {
    const calls: number[] = [];
    const detector: BlankDetector = async (bytes, limit) => {
      calls.push(bytes.byteLength);
      return blankRatio(bytes, limit);
    };
    // Обороты набора поданы обратным порядком: оборот листа 3 (12), пустой оборот листа 2,
    // оборот листа 1 (10).
    const { service, root } = await connect(
      {
        trays: [
          [1, 2, 3],
          [6, 5, 4],
          [7, 8, 9],
          [12, BLANK, 10],
        ],
      },
      { blankDetector: detector },
    );
    unwrap(await service.setBlankMode('hide'));
    await setFrontsScanned(service);
    await scanned(service, 3);
    await untilScored(() => service.snapshot());

    let snapshot = service.snapshot();
    expect(snapshot.assembly?.blank).toEqual({ mode: 'hide', found: 1, hidden: 1, pending: 0 });
    const blankBack = setBack(4, 2);
    expect(keysOf(snapshot)).toEqual(AE1_ORDER);
    // Блок набора — 6 страниц с чередованием, скрыта ровно одна: оборот листа 2 набора.
    const block = snapshot.assembly?.order.filter((page) => page.addedSet === 1) ?? [];
    expect(block.map((page) => page.key)).toEqual(pairBlock(3, 4));
    expect(block.filter((page) => page.blank !== 'hidden')).toHaveLength(5);
    expect(
      snapshot.assembly?.order.filter((page) => page.blank !== null).map((page) => page.key),
    ).toEqual([blankBack]);
    expect(block.find((page) => page.key === blankBack)).toMatchObject({
      blank: 'hidden',
      sheet: 2,
      side: 'back',
    });
    expect(shapeOf(snapshot).slice(4, 10)).toEqual([
      'Д1:1л',
      'Д1:1о',
      'Д1:2л',
      'Д1:2о',
      'Д1:3л',
      'Д1:3о',
    ]);
    // Скрытый в файл не идёт.
    expect(await savedFixtures(service, root)).toEqual([1, 4, 2, 5, 7, 10, 8, 9, 12, 3, 6]);

    // «Это не пустая страница» — оборот возвращается в ленту и PDF на своё место.
    unwrap(await service.setEdits({ ...EMPTY_EDITS, notBlank: [blankBack] }, {}));
    snapshot = service.snapshot();
    expect(snapshot.assembly?.blank).toEqual({ mode: 'hide', found: 0, hidden: 0, pending: 0 });
    expect(snapshot.assembly?.order.every((page) => page.blank === null)).toBe(true);
    expect(snapshot.session?.edits.notBlank).toEqual([blankBack]);
    expect(await savedFixtures(service, root)).toEqual([1, 4, 2, 5, 7, 10, 8, BLANK, 9, 12, 3, 6]);
    // Детектор — по разу на оборот: 3 основных и 3 набора; лица не оцениваются, повторов нет.
    expect(calls).toHaveLength(6);
  });

  it('AE10: журнал v6 с односторонним набором открывается после перезапуска — набор односторонний по якорю, файл переписан v7', async () => {
    const { service, root, restart } = await connect({ trays: [[1, 2, 3], [6, 5, 4], [7]] });
    await scanned(service, 3, 3);
    expect(unwrap(await service.startPass({ kind: 'added', after: F2 }))).toMatchObject({
      end: 'completed',
      pages: 1,
    });

    // Журнал прежней версии: без ссылки пары и решения по оборотам, версия 6.
    const file = layoutOf(root).journalFile;
    const current = JSON.parse(await readFile(file, 'utf8')) as {
      version: number;
      passes: Record<string, unknown>[];
    };
    const v6 = {
      ...current,
      version: 6,
      passes: current.passes.map((pass) =>
        Object.fromEntries(
          Object.entries(pass).filter(([field]) => field !== 'pair' && field !== 'backsDecision'),
        ),
      ),
    };
    await writeFile(file, JSON.stringify(v6));

    const second = await restart();
    const snapshot = second.snapshot();
    expect(
      snapshot.session?.passes.map((pass) => [pass.kind, pass.pair, pass.backsDecision]),
    ).toEqual([
      ['fronts', null, null],
      ['backs', null, null],
      ['added', null, null],
    ]);
    expect(snapshot.assembly?.report).toMatchObject({ mode: 'pairs', pendingSet: null });
    expect(snapshot.assembly?.report.sets).toEqual([
      {
        set: 1,
        fronts: 1,
        backs: 0,
        backsState: null,
        decision: null,
        mismatch: false,
        sides: 'one',
      },
    ]);
    expect(keysOf(snapshot)).toEqual([F1, B(1), F2, 'p03-s01-0001', B(2), F3, B(3)]);

    // Сверка переписала файл текущей версией с дефолтами пары.
    const raw = JSON.parse(await readFile(file, 'utf8')) as {
      version: number;
      passes: { kind: string; pair: unknown; backsDecision: unknown }[];
    };
    expect(raw.version).toBe(7);
    expect(raw.passes.map((pass) => [pass.kind, pass.pair, pass.backsDecision])).toEqual([
      ['fronts', null, null],
      ['backs', null, null],
      ['added', null, null],
    ]);
    // Односторонний набор оборотов не ждёт: очередь без намерения пуста.
    expect(await second.startPass(null)).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'backsPresent' } },
    });
  });
});
