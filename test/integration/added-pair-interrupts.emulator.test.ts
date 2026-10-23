import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '@shared';
import { blankRatio, type BlankDetector } from '../../src/core/detect/blank';
import { probeScanner, type ConnectedScanner } from '../../src/core/escl/connect';
import type { ScanJobLimits } from '../../src/core/escl/scan-job';
import {
  openPassService,
  type PassService,
  type PassServiceOptions,
} from '../../src/core/scan/pass-service';
import { layoutOf } from '../../src/core/storage/layout';
import { SCENARIOS, type Scenario } from '../emulator/scenarios';
import type { Emulator } from '../emulator/server';
import { startTestEmulator } from '../support/emulator';
import { scanned } from '../support/pass-service';
import { pageFixtureOf, pdfPageFixtures } from '../support/fixtures';
import { journalOnDisk } from '../support/session-store';
import { makeTempDataRoot } from '../support/temp-data-root';
import { unwrap } from '../support/result';
import { until, untilScored } from '../support/until';

// Двусторонний добавленный набор — обрывы, «Остановить» и перезапуск на настоящей цепочке (план
// M4.5, U8; R5, R7, R8, R12, R14, R17, R20): эмулятор с лотками по заданиям → служба проходов →
// журнал v7 (роли `addedFronts` / `addedBacks`, `pair`, `backsDecision`) → блок «Д1» по якорю в
// ленте снимка → запись PDF. Приёмочные примеры: AE11 (обрыв оборотов набора — «Досканировать» /
// «Принять»), AE12 («Остановить» на лицах набора до первой страницы), AE17 и AE7 (пустой оборот
// набора в «Скрывать»), AE14 и R10 (смена сканера между проходами набора: новый проход оборотов —
// на новом сканере, досканирование прерванного — только на сканере прохода), R6 (принятые лица
// набора ждут обороты). Полный путь пары и несовпадение — `added-pair*.emulator.test.ts`.
//
// Лотки: основной документ [1, 2, 3] / [6, 5, 4], лица набора [7, 8, 9], обороты набора обратным
// порядком подачи [12, 11, 10] — лист i набора: лицо 6 + i, оборот 9 + i. Счёт листов для
// `fault.sheet` сквозной: 1–6 — основной документ, 7–9 — лица набора, 10–12 — его обороты.
// «Остановить» отбрасывает полученные страницы прохода — так велит спека (`docs/duplexnt.md`,
// «Отмена прохода пользователем…», «Исходные сканы не теряются от сбоя») и UI_SPEC, «Отмена»: на
// первом сегменте лиц набор уходит целиком, на первом сегменте оборотов набор снова ждёт обороты,
// при досканировании уходит только досканированное. Прерванный проход со страницами дают обрыв и
// закрытие окна. Формулировки плана R5/R7 («Остановить» после первой страницы → прерванный проход)
// со спекой расходятся; тесты держатся спеки и ядра, развилка вынесена автору.

// Сбои этого файла — `gone` (ответ `410` сразу), от тишины между страницами тесты не зависят:
// ожидание страницы взято с запасом, чтобы под нагрузкой основная пара не обрывалась сама.
const FAST: Partial<ScanJobLimits> = {
  retryDelayMs: 5,
  busyCeilingMs: 200,
  notReadyCeilingMs: 2000,
  pageIdleTimeoutMs: 1500,
  pageDeadlineMs: 5000,
  deleteDeadlineMs: 300,
};

const OPTIONS = {
  jobLimits: FAST,
  minFreeBytes: 1,
  retry: { ceilingMs: 0 },
} satisfies PassServiceOptions;

const BLANK = 'blank-gray-300';

/** Ключ страницы: проход, сегмент, номер в сегменте. */
const keyOf = (pass: number, segment: number, index: number): string =>
  `p${String(pass).padStart(2, '0')}-s${String(segment).padStart(2, '0')}-${String(index).padStart(4, '0')}`;

/** Якорь набора — оборот листа 2 основного документа (подан вторым, фикстура 5). */
const ANCHOR = keyOf(2, 1, 2);
/** Основной документ парами до якоря включительно и после него. */
const MAIN_HEAD = [keyOf(1, 1, 1), keyOf(2, 1, 3), keyOf(1, 1, 2), ANCHOR];
const MAIN_TAIL = [keyOf(1, 1, 3), keyOf(2, 1, 1)];
/** Лица набора — проход 3. */
const SET_FRONTS = [keyOf(3, 1, 1), keyOf(3, 1, 2), keyOf(3, 1, 3)];
/** Фикстуры показанной ленты: основной документ 1,4,2,5 | набор | 3,6. */
const withSet = (set: readonly (number | string)[]): (number | string)[] => [
  1,
  4,
  2,
  5,
  ...set,
  3,
  6,
];
/** Набор чередованием: 1л, 1о, 2л, 2о, 3л, 3о. */
const SET_INTERLEAVED = [7, 10, 8, 11, 9, 12];

/** Детектор, который считает вызовы. */
function counting() {
  const calls: number[] = [];
  const detector: BlankDetector = (bytes, limit) => {
    calls.push(bytes.byteLength);
    return blankRatio(bytes, limit);
  };
  return { detector, calls };
}

async function connect(scenario: Partial<Scenario>, extra: Partial<PassServiceOptions> = {}) {
  const emulator = await startTestEmulator({ scenario });
  const connected: ConnectedScanner = unwrap(
    await probeScanner({ ...emulator, fingerprint: null }),
  );
  const root = await makeTempDataRoot();
  const snapshots: Snapshot[] = [];
  // Перезапуск — та же служба заново на том же корне и том же сканере (прецедент `blank-backs`).
  const open = async (options: Partial<PassServiceOptions> = extra): Promise<PassService> => {
    let opened: PassService | null = null;
    opened = await openPassService(root, {
      ...OPTIONS,
      ...options,
      onChange: () => {
        if (opened !== null) {
          snapshots.push(opened.snapshot());
        }
      },
    });
    await opened.useScanner(connected);
    return opened;
  };
  const service = await open();
  return { emulator, root, service, snapshots, restart: open };
}

/** Второй сканер B на своём адресе: служба переключается на него, как при выборе в окне. */
async function switchTo(service: PassService, scenario: Partial<Scenario>): Promise<Emulator> {
  const other = await startTestEmulator({ scenario });
  unwrap(await service.useScanner(unwrap(await probeScanner({ ...other, fingerprint: null }))));
  return other;
}

/** Обратно на прежний сканер — тот же адрес и сертификат. */
async function switchBack(service: PassService, emulator: Emulator): Promise<void> {
  unwrap(await service.useScanner(unwrap(await probeScanner({ ...emulator, fingerprint: null }))));
}

const postsOf = (emulator: Emulator): string[] =>
  emulator.requests().filter((it) => it.startsWith('POST /eSCL/ScanJobs'));

/** Основной документ 3+3 и лица набора «после стр. 4» (оборот листа 2). */
async function mainAndSetFronts(service: PassService): Promise<void> {
  await scanned(service, 3, 3);
  expect(unwrap(await service.startPass({ kind: 'addedFronts', after: ANCHOR }))).toMatchObject({
    end: 'completed',
    pages: 3,
  });
}

const keysOf = (snapshot: Snapshot): string[] =>
  snapshot.assembly?.order.map((page) => page.key) ?? [];

/** Страницы набора «Д1» в ленте: ключ, сторона, лист внутри набора. */
const setPagesOf = (snapshot: Snapshot): (string | number | null)[][] =>
  snapshot.assembly?.order
    .filter((page) => page.addedSet === 1)
    .map((page) => [page.key, page.side, page.sheet]) ?? [];

/** Роли проходов журнала в сравнимом виде: `[номер, роль, состояние, pair, решение]`. */
const passesOf = (snapshot: Snapshot): (string | number | null)[][] =>
  snapshot.session?.passes.map((pass) => [
    pass.number,
    pass.kind,
    pass.state,
    pass.pair,
    pass.backsDecision,
  ]) ?? [];

/** Какая фикстура лежит в файле каждой страницы — физический порядок ленты. */
async function fixturesOf(root: string, keys: readonly string[]): Promise<(number | string)[]> {
  const { pagesDir } = layoutOf(root);
  return Promise.all(
    keys.map(async (key) => pageFixtureOf(await readFile(join(pagesDir, `${key}.jpg`)))),
  );
}

/** Показанная лента (без скрытых пустых) — фикстурами. */
const shownFixturesOf = (root: string, snapshot: Snapshot): Promise<(number | string)[]> =>
  fixturesOf(
    root,
    (snapshot.assembly?.order ?? []).filter((page) => page.blank !== 'hidden').map((it) => it.key),
  );

/** Запись одним файлом после прихода оценок; путь к PDF. */
async function saveSingle(service: PassService, root: string, name = 'Документ'): Promise<string> {
  const folder = join(root, 'выход');
  await mkdir(folder, { recursive: true });
  await untilScored(() => service.snapshot());
  const saved = unwrap(
    await service.saveDocuments(folder, { mode: 'single', names: [name], retry: false }),
  );
  expect(saved.failed).toEqual([]);
  return join(folder, `${name}.pdf`);
}

/** Прогоны службы, начатые после отметки `from`: роль, досканирование, ожидаемое число. */
const runsSince = (snapshots: readonly Snapshot[], from: number) =>
  snapshots
    .slice(from)
    .map((it) => it.pass)
    .filter((pass) => pass !== null)
    .map((pass) => [pass.kind, pass.resumed, pass.expected]);

const pageFilesOf = async (root: string, prefix: string): Promise<string[]> =>
  (await readdir(layoutOf(root).pagesDir)).filter((name) => name.startsWith(prefix)).sort();

describe('двусторонний набор: обрывы, «Остановить» и перезапуск через эмулятор (M4.5, U8)', () => {
  it('AE11: обрыв оборотов набора после первой страницы — плашка и подблоки; новое намерение отклонено; «Досканировать» тем же проходом → чередование', async () => {
    const { emulator, root, service, snapshots } = await connect(SCENARIOS['added-pair-jam']);
    await mainAndSetFronts(service);

    expect(await service.startPass(null)).toMatchObject({
      ok: true,
      value: { end: 'interrupted', pages: 1, error: { code: 'scanFeedFailed' } },
    });
    let snapshot = service.snapshot();
    expect(snapshot).toMatchObject({ canResume: true, canAccept: true });
    expect(passesOf(snapshot).at(-1)).toEqual([4, 'addedBacks', 'interrupted', 3, null]);
    expect(snapshot.assembly?.report.sets).toEqual([
      {
        set: 1,
        fronts: 3,
        backs: 1,
        backsState: 'interrupted',
        decision: 'none',
        mismatch: true,
        sides: 'two',
      },
    ]);
    expect(snapshot.assembly?.report.pendingSet).toBeNull();
    // Подблоки: лица в порядке сканирования, затем оборот; номера листа нет (R14).
    expect(keysOf(snapshot)).toEqual([...MAIN_HEAD, ...SET_FRONTS, keyOf(4, 1, 1), ...MAIN_TAIL]);
    expect(setPagesOf(snapshot)).toEqual([
      [SET_FRONTS[0], 'front', null],
      [SET_FRONTS[1], 'front', null],
      [SET_FRONTS[2], 'front', null],
      [keyOf(4, 1, 1), 'back', null],
    ]);
    // Основной документ не тронут.
    expect(snapshot.assembly?.report).toMatchObject({ fronts: 3, backs: 3, mismatch: false });

    // Поверх прерванного новый набор не начинается — ни двусторонний, ни односторонний.
    for (const kind of ['addedFronts', 'added'] as const) {
      expect(await service.startPass({ kind, after: null })).toMatchObject({
        ok: false,
        error: { code: 'sessionConflict', details: { reason: 'passInterrupted' } },
      });
    }

    emulator.clearJam();
    const before = snapshots.length;
    // Пятый лоток сценария — остаток [11, 10].
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 2 });
    const runs = runsSince(snapshots, before);
    expect(runs.length).toBeGreaterThan(0);
    expect(
      runs.every(([kind, resumed, expected]) => kind === 'addedBacks' && resumed && expected === 3),
    ).toBe(true);

    const journal = await journalOnDisk(root);
    expect(journal.passes.map((pass) => pass.number)).toEqual([1, 2, 3, 4]);
    expect(journal.passes.at(-1)).toMatchObject({ number: 4, kind: 'addedBacks', pair: 3 });
    expect(journal.passes.at(-1)?.segments.map((it) => [it.state, it.pageCount])).toEqual([
      ['interrupted', 1],
      ['completed', 2],
    ]);
    snapshot = service.snapshot();
    expect(snapshot).toMatchObject({ canResume: false, canAccept: false });
    expect(snapshot.assembly?.report.sets[0]).toMatchObject({
      backs: 3,
      backsState: 'completed',
      decision: 'none',
      mismatch: false,
    });
    // Досканированный сегмент участвует в чередовании (R12): оборот листа i — с конца прохода.
    expect(setPagesOf(snapshot)).toEqual([
      [SET_FRONTS[0], 'front', 1],
      [keyOf(4, 2, 2), 'back', 1],
      [SET_FRONTS[1], 'front', 2],
      [keyOf(4, 2, 1), 'back', 2],
      [SET_FRONTS[2], 'front', 3],
      [keyOf(4, 1, 1), 'back', 3],
    ]);
    expect(await shownFixturesOf(root, snapshot)).toEqual(withSet(SET_INTERLEAVED));
    expect(await pdfPageFixtures(await saveSingle(service, root))).toEqual(
      withSet(SET_INTERLEAVED),
    );
  });

  it('AE11, R20: прерванные обороты набора пишутся в PDF подблоками; «Принять» → `kept` без модалки, решение переживает перезапуск', async () => {
    const { root, service, restart } = await connect(SCENARIOS['added-pair-jam']);
    await mainAndSetFronts(service);
    await service.startPass(null);
    const subBlocks = withSet([7, 8, 9, 12]);

    // Сохранение при прерванных оборотах набора не блокируется (R20).
    expect(await pdfPageFixtures(await saveSingle(service, root, 'До решения'))).toEqual(subBlocks);

    unwrap(await service.acceptPass());
    let snapshot = service.snapshot();
    expect(snapshot).toMatchObject({ canResume: false, canAccept: false });
    expect(passesOf(snapshot).slice(2)).toEqual([
      [3, 'addedFronts', 'completed', null, 'kept'],
      [4, 'addedBacks', 'accepted', 3, null],
    ]);
    expect(snapshot.assembly?.report.sets[0]).toMatchObject({
      fronts: 3,
      backs: 1,
      backsState: 'accepted',
      decision: 'kept',
      mismatch: true,
    });
    expect(snapshot.assembly?.report.pendingSet).toBeNull();
    // Решение уже есть: модалке набора решать нечего — обе команды отказывают.
    for (const decided of [await service.keepSetBacks(1), await service.rescanSetBacks(1)]) {
      expect(decided).toMatchObject({
        ok: false,
        error: { code: 'sessionConflict', details: { reason: 'setNotMismatched' } },
      });
    }
    expect(await shownFixturesOf(root, snapshot)).toEqual(subBlocks);
    expect(await pdfPageFixtures(await saveSingle(service, root))).toEqual(subBlocks);

    const second = await restart();
    snapshot = second.snapshot();
    expect((await journalOnDisk(root)).passes.find((pass) => pass.number === 3)).toMatchObject({
      kind: 'addedFronts',
      backsDecision: 'kept',
    });
    expect(snapshot.assembly?.report.sets[0]).toMatchObject({ decision: 'kept', mismatch: true });
    expect(snapshot.assembly?.report.pendingSet).toBeNull();
    expect(keysOf(snapshot)).toEqual([...MAIN_HEAD, ...SET_FRONTS, keyOf(4, 1, 1), ...MAIN_TAIL]);
  });

  it('AE11: по прерванным оборотам набора модалка не решает — «Оставить как есть» и «Переснять» отказывают `passInterrupted`, журнал и страницы целы', async () => {
    const { root, service } = await connect(SCENARIOS['added-pair-jam']);
    await mainAndSetFronts(service);
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'interrupted', pages: 1 });
    const journal = await journalOnDisk(root);
    const before = service.snapshot();

    for (const decided of [await service.keepSetBacks(1), await service.rescanSetBacks(1)]) {
      expect(decided).toMatchObject({
        ok: false,
        error: { code: 'sessionConflict', details: { reason: 'passInterrupted' } },
      });
    }

    expect(await journalOnDisk(root)).toEqual(journal);
    expect(await pageFilesOf(root, 'p04-')).toEqual([`${keyOf(4, 1, 1)}.jpg`]);
    const snapshot = service.snapshot();
    expect(snapshot).toMatchObject({ canResume: true, canAccept: true });
    expect(passesOf(snapshot)).toEqual(passesOf(before));
    expect(snapshot.assembly?.report.sets).toEqual(before.assembly?.report.sets);
    expect(keysOf(snapshot)).toEqual([...MAIN_HEAD, ...SET_FRONTS, keyOf(4, 1, 1), ...MAIN_TAIL]);
  });

  it('досканирование коротким остатком: 2 из 3 двумя сегментами — несовпадение без решения; «Переснять» удаляет оба сегмента и их оценки; новый проход — чередование, детектор по разу', async () => {
    const { detector, calls } = counting();
    const { emulator, root, service } = await connect(
      { ...SCENARIOS['added-pair-jam'], trays: SCENARIOS['added-pair-jam'].trays.slice(0, 4) },
      { blankDetector: detector },
    );
    unwrap(await service.setBlankMode('hide'));
    await mainAndSetFronts(service);
    await service.startPass(null);

    emulator.clearJam();
    emulator.reloadTray([11]);
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 1 });
    await untilScored(() => service.snapshot());
    let snapshot = service.snapshot();
    expect(passesOf(snapshot).at(-1)).toEqual([4, 'addedBacks', 'completed', 3, null]);
    expect(snapshot.assembly?.report.sets[0]).toMatchObject({
      fronts: 3,
      backs: 2,
      backsState: 'completed',
      decision: 'none',
      mismatch: true,
    });
    // Подблок оборотов — порядком документа, обратным подаче: досканированный первым.
    expect(keysOf(snapshot)).toEqual([
      ...MAIN_HEAD,
      ...SET_FRONTS,
      keyOf(4, 2, 1),
      keyOf(4, 1, 1),
      ...MAIN_TAIL,
    ]);
    // Обороты основного документа (3) и оба сегмента оборотов набора — по разу; лица — нет.
    expect(calls).toHaveLength(5);
    const blankDir = join(layoutOf(root).derivedDir, snapshot.session?.id ?? '', 'blank');
    expect((await readdir(blankDir)).filter((name) => name.startsWith('p04-')).sort()).toEqual([
      `${keyOf(4, 1, 1)}.json`,
      `${keyOf(4, 2, 1)}.json`,
    ]);
    expect(await pageFilesOf(root, 'p04-')).toEqual([
      `${keyOf(4, 1, 1)}.jpg`,
      `${keyOf(4, 2, 1)}.jpg`,
    ]);

    unwrap(await service.rescanSetBacks(1));
    snapshot = service.snapshot();
    expect(passesOf(snapshot).map(([number]) => number)).toEqual([1, 2, 3]);
    expect(snapshot.assembly?.report.pendingSet).toBe(1);
    expect(snapshot.assembly?.report.sets[0]).toMatchObject({ backs: 0, backsState: null });
    expect(keysOf(snapshot)).toEqual([...MAIN_HEAD, ...SET_FRONTS, ...MAIN_TAIL]);
    expect(await pageFilesOf(root, 'p04-')).toEqual([]);
    expect((await readdir(blankDir)).filter((name) => name.startsWith('p04-'))).toEqual([]);
    const journal = await journalOnDisk(root);
    expect(journal.passes.map((pass) => pass.number)).toEqual([1, 2, 3]);
    expect(journal.deletions).toEqual([]);

    emulator.reloadTray([12, 11, 10]);
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 3 });
    await untilScored(() => service.snapshot());
    snapshot = service.snapshot();
    expect(passesOf(snapshot).at(-1)).toEqual([5, 'addedBacks', 'completed', 3, null]);
    expect(snapshot.assembly?.report.sets[0]).toMatchObject({ backs: 3, mismatch: false });
    expect(await shownFixturesOf(root, snapshot)).toEqual(withSet(SET_INTERLEAVED));
    expect(calls).toHaveLength(8);
    // Повторных оценок нет.
    await delay(200);
    expect(calls).toHaveLength(8);
  }, 20_000);

  it('R7: обрыв оборотов набора до первой страницы — проход снят, набор снова ждёт, основной документ не тронут; следующий запуск — новый проход оборотов набора', async () => {
    const { emulator, root, service, snapshots } = await connect({
      ...SCENARIOS['added-pair'],
      // Сквозной лист 10 — первый оборот набора.
      fault: { sheet: 10, kind: 'gone' },
    });
    await mainAndSetFronts(service);
    const before = keysOf(service.snapshot());

    expect(await service.startPass(null)).toMatchObject({
      ok: true,
      value: { end: 'interrupted', pages: 0, error: { code: 'scanFeedFailed' } },
    });
    const snapshot = service.snapshot();
    expect(snapshot).toMatchObject({ canResume: false, canAccept: false });
    expect(passesOf(snapshot)).toEqual([
      [1, 'fronts', 'completed', null, null],
      [2, 'backs', 'completed', null, null],
      [3, 'addedFronts', 'completed', null, 'none'],
    ]);
    expect(snapshot.assembly?.report.pendingSet).toBe(1);
    expect(snapshot.assembly?.report).toMatchObject({ fronts: 3, backs: 3, mismatch: false });
    expect(keysOf(snapshot)).toEqual(before);
    expect((await journalOnDisk(root)).passes.map((pass) => pass.number)).toEqual([1, 2, 3]);
    expect(await pageFilesOf(root, 'p04-')).toEqual([]);

    // Лоток оборотов набора после обрыва не тронут: следующий запуск — новый проход (не
    // досканирование) с ожидаемым числом лиц набора.
    emulator.clearJam();
    emulator.reloadTray([12, 11, 10]);
    const mark = snapshots.length;
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 3 });
    expect(runsSince(snapshots, mark)).toContainEqual(['addedBacks', false, 3]);
    expect(passesOf(service.snapshot()).at(-1)).toEqual([5, 'addedBacks', 'completed', 3, null]);
    expect(await shownFixturesOf(root, service.snapshot())).toEqual(withSet(SET_INTERLEAVED));
  });

  it('AE12: «Остановить» на лицах набора до первой страницы — набор отброшен, последний проход прежний, наборов нет', async () => {
    const { emulator, root, service, snapshots } = await connect(
      {
        ...SCENARIOS['added-pair-stop-fronts'],
        // Медленный лист сценария, укороченный ради времени теста: окно для «Остановить» — до
        // заголовков первой страницы; ожидание заголовков у задания — с запасом над паузой.
        pageDelayMs: 400,
      },
      { jobLimits: { ...FAST, pageIdleTimeoutMs: 3000 } },
    );
    await scanned(service, 3, 3);
    const before = keysOf(service.snapshot());
    const mark = snapshots.length;

    const fronts = service.startPass({ kind: 'addedFronts', after: ANCHOR });
    await until(() => {
      const pass = service.snapshot().pass;
      return pass?.kind === 'addedFronts' && pass.phase === 'scanning';
    });
    expect(service.snapshot().pass?.pages).toBe(0);
    expect(await service.stopPass()).toEqual({ ok: true, value: undefined });
    expect(unwrap(await fronts)).toEqual({ end: 'stopped', pages: 0, error: null });
    // Остановлено именно до первой страницы: ни один снимок прогона лиц набора страниц не видел,
    // и устройство отдало страницы только основного документа (3 + 3).
    const frontsRuns = snapshots
      .slice(mark)
      .map((it) => it.pass)
      .filter((pass) => pass?.kind === 'addedFronts');
    expect(frontsRuns.length).toBeGreaterThan(0);
    expect(frontsRuns.every((pass) => pass?.pages === 0)).toBe(true);
    expect(emulator.requests().filter((it) => it.endsWith('/NextDocument 200'))).toHaveLength(6);

    const snapshot = service.snapshot();
    expect(passesOf(snapshot)).toEqual([
      [1, 'fronts', 'completed', null, null],
      [2, 'backs', 'completed', null, null],
    ]);
    expect(snapshot.assembly?.report).toMatchObject({ sets: [], pendingSet: null });
    expect(snapshot).toMatchObject({ canResume: false, canAccept: false, pass: null });
    expect(keysOf(snapshot)).toEqual(before);
    const journal = await journalOnDisk(root);
    expect(journal.passes.map((pass) => [pass.number, pass.kind])).toEqual([
      [1, 'fronts'],
      [2, 'backs'],
    ]);
    expect(await pageFilesOf(root, 'p03-')).toEqual([]);
  }, 20_000);

  it('«Остановить» на лицах набора после первой страницы — по спеке отмена отбрасывает полученное: набор уходит целиком, ожидания пары нет (план R5 — иначе, развилка у автора)', async () => {
    const { root, service } = await connect(
      { ...SCENARIOS['added-pair-stop-fronts'], pageDelayMs: 150 },
      { jobLimits: { ...FAST, pageIdleTimeoutMs: 3000 } },
    );
    await scanned(service, 3, 3);

    const fronts = service.startPass({ kind: 'addedFronts', after: ANCHOR });
    await until(() => service.snapshot().pass?.pages === 1);
    unwrap(await service.stopPass());
    expect(unwrap(await fronts)).toMatchObject({ end: 'stopped' });

    const snapshot = service.snapshot();
    expect(passesOf(snapshot).map(([number]) => number)).toEqual([1, 2]);
    expect(snapshot.assembly?.report).toMatchObject({ sets: [], pendingSet: null });
    expect(snapshot).toMatchObject({ canResume: false, canAccept: false });
    expect(await pageFilesOf(root, 'p03-')).toEqual([]);
  }, 20_000);

  it('«Остановить» на первом сегменте оборотов набора со страницей — по спеке проход снят, набор снова ждёт обороты (экран flip набора; план R7 — иначе, развилка у автора)', async () => {
    const { root, service } = await connect(
      { ...SCENARIOS['added-pair'], pageDelayMs: 150 },
      { jobLimits: { ...FAST, pageIdleTimeoutMs: 3000 } },
    );
    await mainAndSetFronts(service);

    const backs = service.startPass(null);
    await until(() => service.snapshot().pass?.pages === 1);
    unwrap(await service.stopPass());
    expect(unwrap(await backs)).toMatchObject({ end: 'stopped' });

    const snapshot = service.snapshot();
    expect(passesOf(snapshot).map(([number, kind]) => [number, kind])).toEqual([
      [1, 'fronts'],
      [2, 'backs'],
      [3, 'addedFronts'],
    ]);
    expect(snapshot.assembly?.report.pendingSet).toBe(1);
    expect(snapshot).toMatchObject({ canResume: false, canAccept: false });
    expect(await pageFilesOf(root, 'p04-')).toEqual([]);
  }, 20_000);

  it('«Остановить» при досканировании оборотов набора отбрасывает только досканированное — проход снова прерван с прежней страницей', async () => {
    const { emulator, root, service } = await connect(
      { ...SCENARIOS['added-pair-jam'], pageDelayMs: 150 },
      { jobLimits: { ...FAST, pageIdleTimeoutMs: 3000 } },
    );
    await mainAndSetFronts(service);
    await service.startPass(null);

    emulator.clearJam();
    const resumed = service.startPass(null);
    await until(() => service.snapshot().pass?.pages === 1);
    unwrap(await service.stopPass());
    expect(unwrap(await resumed)).toMatchObject({ end: 'stopped' });

    const snapshot = service.snapshot();
    expect(snapshot).toMatchObject({ canResume: true, canAccept: true });
    expect(passesOf(snapshot).at(-1)).toEqual([4, 'addedBacks', 'interrupted', 3, null]);
    expect(snapshot.assembly?.report.sets[0]).toMatchObject({ backs: 1, mismatch: true });
    expect(await pageFilesOf(root, 'p04-')).toEqual([`${keyOf(4, 1, 1)}.jpg`]);
  }, 20_000);

  it('R5, R8: обрыв лиц набора после первой страницы → перезапуск → плашка, набор односторонним блоком; досканирование тем же проходом → набор ждёт обороты → чередование', async () => {
    const { emulator, root, service, snapshots, restart } = await connect({
      ...SCENARIOS['added-pair'],
      trays: SCENARIOS['added-pair'].trays.slice(0, 3),
      // Сквозной лист 8 — второе лицо набора.
      fault: { sheet: 8, kind: 'gone' },
    });
    await scanned(service, 3, 3);
    expect(await service.startPass({ kind: 'addedFronts', after: ANCHOR })).toMatchObject({
      ok: true,
      value: { end: 'interrupted', pages: 1 },
    });

    const second = await restart();
    let snapshot = second.snapshot();
    expect(snapshot).toMatchObject({ canResume: true, canAccept: true });
    expect(passesOf(snapshot).at(-1)).toEqual([3, 'addedFronts', 'interrupted', null, 'none']);
    expect(snapshot.session?.passes.at(-1)?.after).toBe(ANCHOR);
    // Прерванные лица набор обороты не ждут: `flip` набора нет, блок — одна сторона.
    expect(snapshot.assembly?.report.pendingSet).toBeNull();
    expect(snapshot.assembly?.report.sets).toEqual([
      {
        set: 1,
        fronts: 1,
        backs: 0,
        backsState: null,
        decision: 'none',
        mismatch: false,
        sides: 'two',
      },
    ]);
    expect(keysOf(snapshot)).toEqual([...MAIN_HEAD, keyOf(3, 1, 1), ...MAIN_TAIL]);
    expect(setPagesOf(snapshot).map(([key, side]) => [key, side])).toEqual([
      [keyOf(3, 1, 1), 'front'],
    ]);
    expect(await second.startPass({ kind: 'addedFronts', after: null })).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'passInterrupted' } },
    });

    emulator.clearJam();
    emulator.reloadTray([8, 9]);
    let mark = snapshots.length;
    expect(unwrap(await second.startPass(null))).toMatchObject({ end: 'completed', pages: 2 });
    expect(runsSince(snapshots, mark)).toContainEqual(['addedFronts', true, null]);
    snapshot = second.snapshot();
    expect(passesOf(snapshot).at(-1)).toEqual([3, 'addedFronts', 'completed', null, 'none']);
    expect(snapshot.assembly?.report.pendingSet).toBe(1);
    expect(keysOf(snapshot)).toEqual([
      ...MAIN_HEAD,
      keyOf(3, 1, 1),
      keyOf(3, 2, 1),
      keyOf(3, 2, 2),
      ...MAIN_TAIL,
    ]);

    emulator.reloadTray([12, 11, 10]);
    mark = snapshots.length;
    expect(unwrap(await second.startPass(null))).toMatchObject({ end: 'completed', pages: 3 });
    expect(runsSince(snapshots, mark)).toContainEqual(['addedBacks', false, 3]);
    snapshot = second.snapshot();
    expect(passesOf(snapshot).at(-1)).toEqual([4, 'addedBacks', 'completed', 3, null]);
    expect(snapshot.assembly?.report.pendingSet).toBeNull();
    expect(await shownFixturesOf(root, snapshot)).toEqual(withSet(SET_INTERLEAVED));
  });

  it('R8: закрытие окна во время оборотов набора → перезапуск — прерванный проход оборотов набора со ссылкой пары; досканирование на том же сканере → чередование', async () => {
    const { emulator, root, service, snapshots, restart } = await connect({
      ...SCENARIOS['added-pair'],
      pageDelayMs: 100,
    });
    await mainAndSetFronts(service);

    const backs = service.startPass(null);
    await until(() => service.snapshot().pass?.pages === 1);
    await service.interrupt(2000);
    expect(unwrap(await backs)).toMatchObject({ end: 'interrupted' });
    const fed = (await journalOnDisk(root)).passes.at(-1)?.segments[0]?.pageCount ?? 0;
    expect(fed).toBeGreaterThanOrEqual(1);
    expect(fed).toBeLessThan(3);

    const second = await restart();
    let snapshot = second.snapshot();
    expect(snapshot).toMatchObject({ canResume: true, canAccept: true });
    expect(passesOf(snapshot).slice(2)).toEqual([
      [3, 'addedFronts', 'completed', null, 'none'],
      [4, 'addedBacks', 'interrupted', 3, null],
    ]);
    expect(snapshot.assembly?.report.pendingSet).toBeNull();
    expect(snapshot.assembly?.report.sets[0]).toMatchObject({
      fronts: 3,
      backs: fed,
      backsState: 'interrupted',
      mismatch: true,
    });

    // Задание закрыто `DELETE`: остаток лотка устройство прогнало — кладём его заново.
    emulator.reloadTray([12, 11, 10].slice(fed));
    const mark = snapshots.length;
    expect(unwrap(await second.startPass(null))).toMatchObject({
      end: 'completed',
      pages: 3 - fed,
    });
    expect(runsSince(snapshots, mark)).toContainEqual(['addedBacks', true, 3]);
    snapshot = second.snapshot();
    expect(passesOf(snapshot).at(-1)).toEqual([4, 'addedBacks', 'completed', 3, null]);
    expect(snapshot.assembly?.report.sets[0]).toMatchObject({ backs: 3, mismatch: false });
    expect(await shownFixturesOf(root, snapshot)).toEqual(withSet(SET_INTERLEAVED));
  }, 20_000);

  it('AE14, R10: сканер сменился между лицами и оборотами набора — обороты новым проходом на сканере B с его параметрами, блок чередованием', async () => {
    const { emulator, root, service, snapshots } = await connect(SCENARIOS['added-pair-declined']);
    await mainAndSetFronts(service);
    const other = await switchTo(service, { trays: [[12, 11, 10]] });
    const switched = service.snapshot().scanner;
    expect(switched).toMatchObject({ kind: 'ready', scanner: { port: other.port } });
    // Параметры B отличаются от прохода лиц набора: обороты берут текущие, а не параметры лиц.
    if (switched.kind !== 'ready') {
      throw new Error('сканер B не готов');
    }
    const { params } = switched;
    expect(params.resolution).toBe(300);
    unwrap(await service.setParams({ ...params, resolution: 200 }));
    // Набор по-прежнему ждёт обороты: смена сканера `flip` набора не снимает.
    expect(service.snapshot().assembly?.report.pendingSet).toBe(1);

    const mark = snapshots.length;
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 3 });
    expect(runsSince(snapshots, mark)).toContainEqual(['addedBacks', false, 3]);

    // Задание ушло к B; к A после лиц набора — ни одного.
    expect(postsOf(other)).toEqual(['POST /eSCL/ScanJobs 201']);
    expect(other.requests().filter((it) => it.endsWith('/NextDocument 200'))).toHaveLength(3);
    expect(postsOf(emulator)).toHaveLength(3);
    const journal = await journalOnDisk(root);
    const [setFronts, setBacks] = journal.passes.slice(2);
    expect(setFronts?.origin?.scanner).toMatchObject({ host: emulator.host, port: emulator.port });
    expect(setBacks).toMatchObject({ number: 4, kind: 'addedBacks', pair: 3 });
    expect(setBacks?.origin?.scanner).toMatchObject({ host: other.host, port: other.port });
    expect(setBacks?.origin?.scanner.fingerprint).toBe(other.fingerprint);
    expect(setFronts?.origin?.params).toEqual(params);
    expect(setBacks?.origin?.params).toEqual({ ...params, resolution: 200 });
    expect(other.receivedSettings).toHaveLength(1);
    expect(other.receivedSettings[0]).toContain('<scan:XResolution>200</scan:XResolution>');

    const snapshot = service.snapshot();
    expect(passesOf(snapshot).at(-1)).toEqual([4, 'addedBacks', 'completed', 3, null]);
    expect(snapshot.assembly?.report.pendingSet).toBeNull();
    expect(snapshot.assembly?.report.sets[0]).toMatchObject({
      fronts: 3,
      backs: 3,
      mismatch: false,
    });
    expect(await shownFixturesOf(root, snapshot)).toEqual(withSet(SET_INTERLEAVED));
    expect(await pdfPageFixtures(await saveSingle(service, root))).toEqual(
      withSet(SET_INTERLEAVED),
    );
  });

  it('R10: досканирование прерванных оборотов набора на другом сканере — `otherScanner` до сети, принять можно; на прежнем сканере досканирование идёт', async () => {
    const { emulator, root, service } = await connect(SCENARIOS['added-pair-jam']);
    await mainAndSetFronts(service);
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'interrupted', pages: 1 });
    const journal = await journalOnDisk(root);

    const other = await switchTo(service, { trays: [[11, 10]] });
    expect(await service.startPass(null)).toEqual({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'otherScanner' } },
    });
    // К B не ушло ни одного задания; плашка с «Принять» цела, досканировать здесь нельзя.
    expect(postsOf(other)).toEqual([]);
    expect(other.jobs()).toEqual([]);
    expect(service.snapshot()).toMatchObject({ canResume: false, canAccept: true });
    expect(passesOf(service.snapshot()).at(-1)).toEqual([4, 'addedBacks', 'interrupted', 3, null]);
    expect(await journalOnDisk(root)).toEqual(journal);

    await switchBack(service, emulator);
    expect(service.snapshot()).toMatchObject({ canResume: true, canAccept: true });
    emulator.clearJam();
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 2 });
    expect(postsOf(other)).toEqual([]);
    expect(passesOf(service.snapshot()).at(-1)).toEqual([4, 'addedBacks', 'completed', 3, null]);
    expect(await shownFixturesOf(root, service.snapshot())).toEqual(withSet(SET_INTERLEAVED));
  });

  it('R6: обрыв лиц набора на втором листе → «Принять» — набор из одного лица ждёт обороты; оборот одним листом — чередование без несовпадения', async () => {
    const { root, service, snapshots } = await connect({
      ...SCENARIOS['added-pair'],
      trays: [...SCENARIOS['added-pair'].trays.slice(0, 3), [10]],
      // Сквозной лист 8 — второе лицо набора.
      fault: { sheet: 8, kind: 'gone' },
    });
    await scanned(service, 3, 3);
    expect(await service.startPass({ kind: 'addedFronts', after: ANCHOR })).toMatchObject({
      ok: true,
      value: { end: 'interrupted', pages: 1, error: { code: 'scanFeedFailed' } },
    });
    expect(service.snapshot().assembly?.report.pendingSet).toBeNull();

    unwrap(await service.acceptPass());
    let snapshot = service.snapshot();
    expect(snapshot).toMatchObject({ canResume: false, canAccept: false });
    expect(passesOf(snapshot).at(-1)).toEqual([3, 'addedFronts', 'accepted', null, 'none']);
    expect(snapshot.assembly?.report.pendingSet).toBe(1);
    expect(snapshot.assembly?.report.sets[0]).toMatchObject({ set: 1, fronts: 1, backs: 0 });

    const mark = snapshots.length;
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 1 });
    expect(runsSince(snapshots, mark)).toContainEqual(['addedBacks', false, 1]);
    snapshot = service.snapshot();
    expect(passesOf(snapshot).at(-1)).toEqual([4, 'addedBacks', 'completed', 3, null]);
    expect(snapshot.assembly?.report.pendingSet).toBeNull();
    expect(snapshot.assembly?.report.sets[0]).toMatchObject({
      fronts: 1,
      backs: 1,
      backsState: 'completed',
      mismatch: false,
    });
    expect(setPagesOf(snapshot)).toEqual([
      [keyOf(3, 1, 1), 'front', 1],
      [keyOf(4, 1, 1), 'back', 1],
    ]);
    expect(await shownFixturesOf(root, snapshot)).toEqual(withSet([7, 10]));
    expect(await pdfPageFixtures(await saveSingle(service, root))).toEqual(withSet([7, 10]));
  });

  it('AE17, AE7: набор из одного листа с пустым оборотом в «Скрывать» — оборот оценён и скрыт, в ленте одно лицо «Д1», PDF без пустого', async () => {
    const { detector, calls } = counting();
    const { root, service } = await connect(SCENARIOS['added-pair-blank'], {
      blankDetector: detector,
    });
    unwrap(await service.setBlankMode('hide'));
    await scanned(service, 3, 3);
    expect(unwrap(await service.startPass({ kind: 'addedFronts', after: ANCHOR }))).toMatchObject({
      end: 'completed',
      pages: 1,
    });
    expect(service.snapshot().assembly?.report.pendingSet).toBe(1);
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 1 });
    await untilScored(() => service.snapshot());

    const snapshot = service.snapshot();
    expect(snapshot.assembly?.blank).toEqual({ mode: 'hide', found: 1, hidden: 1, pending: 0 });
    // Полная лента ядра держит скрытый оборот на месте — за лицом листа набора.
    expect(keysOf(snapshot)).toEqual([...MAIN_HEAD, keyOf(3, 1, 1), keyOf(4, 1, 1), ...MAIN_TAIL]);
    expect(
      snapshot.assembly?.order
        .filter((page) => page.addedSet === 1)
        .map((page) => [page.key, page.side, page.sheet, page.blank]),
    ).toEqual([
      [keyOf(3, 1, 1), 'front', 1, null],
      [keyOf(4, 1, 1), 'back', 1, 'hidden'],
    ]);
    expect(snapshot.assembly?.report.sets[0]).toMatchObject({
      fronts: 1,
      backs: 1,
      mismatch: false,
    });
    // Детектор — только по оборотам: три основного документа и один набора; лица — нет.
    expect(calls).toHaveLength(4);
    expect(await fixturesOf(root, [keyOf(4, 1, 1)])).toEqual([BLANK]);
    expect(await shownFixturesOf(root, snapshot)).toEqual(withSet([7]));

    expect(await pdfPageFixtures(await saveSingle(service, root))).toEqual(withSet([7]));
    expect(service.snapshot().session?.saved).toBe(true);
  });
});
