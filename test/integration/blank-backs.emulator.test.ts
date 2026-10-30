import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { EMPTY_EDITS, type BlankMode, type Snapshot } from '@shared';
import { blankRatio, type BlankDetector } from '../../src/core/detect/blank';
import { probeScanner, type ConnectedScanner } from '../../src/core/escl/connect';
import {
  openPassService,
  type PassService,
  type PassServiceOptions,
} from '../../src/core/scan/pass-service';
import { layoutOf } from '../../src/core/storage/layout';
import { realStorageFs, type StorageFs } from '../../src/core/storage/storage-fs';
import { SCENARIOS, type Scenario } from '../emulator/scenarios';
import { startTestEmulator } from '../support/emulator';
import { fsError, interceptFs } from '../support/intercept-fs';
import { pageFixtureOf, pdfImageStreams, scanFixture } from '../support/fixtures';
import { makeTempDataRoot } from '../support/temp-data-root';
import { unwrap } from '../support/result';
import { until, untilScored } from '../support/until';
import { levelWorker } from '../support/image-worker';
import { FAST_JOB_LIMITS } from '../support/pass-service';

// Пустые обороты — полный путь на настоящей цепочке (план M4, U8): эмулятор с настоящими
// пустыми сканами в лотке оборотов → служба с детектором → оценки как производное (кэш в
// `derived/<id>/blank`) → флаги в ленте снимка → запись PDF без скрытых → перезапуск. Приёмочные
// примеры плана: AE1, AE3–AE5, AE7, AE8, AE11; плюс отложенный из ревью сессий 1–2 тест
// «Остановить» на проходе оборотов с подсчётом вызовов детектора. AE12 (журнал v5 → v6) —
// `src/core/storage/journal.test.ts`. Сценарии эмулятора — те же, что у `npm run emulator` и
// CDP-смоука.

const OPTIONS = {
  jobLimits: FAST_JOB_LIMITS,
  imageWorker: levelWorker,
  minFreeBytes: 1,
  retry: { ceilingMs: 0 },
} satisfies PassServiceOptions;

const BLANK = 'blank-gray-300';

/** Ключи страниц: лица `p01-s01-NNNN`, обороты `p02-s01-NNNN` в порядке подачи (обратном). */
const front = (sheet: number): string => `p01-s01-${String(sheet).padStart(4, '0')}`;
const back = (fed: number): string => `p02-s01-${String(fed).padStart(4, '0')}`;
/** Оборот листа `sheet` в пачке из `sheets` листов: подан `sheets - sheet + 1`-м. */
const backOf = (sheet: number, sheets = 12): string => back(sheets - sheet + 1);

/** Пачка `blank-backs`: пустые обороты у листов 4, 9, 12. */
const HIDDEN_12 = [backOf(4), backOf(9), backOf(12)];
/** Лента пар из 12 листов без пустых: фикстуры лиц 1..12, оборотов 13..24. */
const PAIRS_21: readonly (number | string)[] = [
  1, 13, 2, 14, 3, 15, 4, 5, 17, 6, 18, 7, 19, 8, 20, 9, 10, 22, 11, 23, 12,
];
const PAIRS_24: readonly (number | string)[] = [
  1,
  13,
  2,
  14,
  3,
  15,
  4,
  BLANK,
  5,
  17,
  6,
  18,
  7,
  19,
  8,
  20,
  9,
  BLANK,
  10,
  22,
  11,
  23,
  12,
  BLANK,
];

/** Детектор, который считает вызовы и при желании отвечает с задержкой. */
function counting(delayMs = 0) {
  const calls: number[] = [];
  const detector: BlankDetector = async (bytes, limit) => {
    calls.push(bytes.byteLength);
    if (delayMs > 0) {
      await delay(delayMs);
    }
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
  const open = async (options: Partial<PassServiceOptions> = extra): Promise<PassService> => {
    const service = await openPassService(root, { ...OPTIONS, ...options });
    await service.useScanner(connected);
    return service;
  };
  const service = await open();
  return { emulator, connected, root, service, restart: open };
}

const keysOf = (snapshot: Snapshot): string[] =>
  snapshot.assembly?.order.map((page) => page.key) ?? [];

const hiddenOf = (snapshot: Snapshot): string[] =>
  snapshot.assembly?.order.filter((page) => page.blank === 'hidden').map((page) => page.key) ?? [];

const markedOf = (snapshot: Snapshot): string[] =>
  snapshot.assembly?.order.filter((page) => page.blank === 'marked').map((page) => page.key) ?? [];

/** Какая фикстура (номер или имя скана) лежит на каждой странице PDF — порядок сверяется точно. */
async function pdfFixtures(path: string): Promise<(number | string)[]> {
  const streams = await pdfImageStreams(await readFile(path));
  return streams.map((stream) => pageFixtureOf(stream.contents));
}

async function scanned(service: PassService, ...pages: readonly number[]): Promise<void> {
  for (const count of pages) {
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: count });
  }
}

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

const blankDirOf = (root: string, snapshot: Snapshot): string =>
  join(layoutOf(root).derivedDir, snapshot.session?.id ?? '', 'blank');

/** Пачка `blank-backs` в режиме `mode`: два прохода, оценки пришли. */
async function blankBacks(mode: BlankMode, extra: Partial<PassServiceOptions> = {}) {
  const harness = await connect(SCENARIOS['blank-backs'], extra);
  unwrap(await harness.service.setBlankMode(mode));
  await scanned(harness.service, 12, 12);
  await untilScored(() => harness.service.snapshot());
  return harness;
}

describe('пустые обороты — полный путь через эмулятор (M4, U8)', () => {
  it('AE1: «Скрывать» — 24 страницы в ленте ядра, три скрыты, PDF из 21 в порядке пар; кэш оценок на диске', async () => {
    const { detector, calls } = counting();
    const { service, root } = await blankBacks('hide', { blankDetector: detector });

    const snapshot = service.snapshot();
    expect(snapshot.session?.blankMode).toBe('hide');
    expect(snapshot.assembly?.blank).toEqual({ mode: 'hide', found: 3, hidden: 3, pending: 0 });
    expect(keysOf(snapshot)).toHaveLength(24);
    expect(hiddenOf(snapshot)).toEqual(HIDDEN_12);
    expect(markedOf(snapshot)).toEqual([]);
    // Скрытые — на своих местах в полной ленте: оборот листа 4 сразу за его лицом.
    expect(keysOf(snapshot).indexOf(backOf(4))).toBe(keysOf(snapshot).indexOf(front(4)) + 1);
    // Оценивались только обороты — по разу.
    expect(calls).toHaveLength(12);
    expect((await readdir(blankDirOf(root, snapshot))).sort()).toEqual(
      Array.from({ length: 12 }, (_, index) => `${back(index + 1)}.json`).sort(),
    );
    // Исходник скрытой страницы на месте: пустой скан байт в байт (данные священны).
    expect(
      (await readFile(join(layoutOf(root).pagesDir, `${backOf(12)}.jpg`))).equals(
        scanFixture(BLANK),
      ),
    ).toBe(true);

    expect(await pdfFixtures(await saveSingle(service, root))).toEqual(PAIRS_21);
    expect(service.snapshot().session?.saved).toBe(true);
  });

  it('AE4: «Помечать» — 24 страницы в файле, три помечены, скрытых нет', async () => {
    const { service, root } = await blankBacks('mark');

    const snapshot = service.snapshot();
    expect(snapshot.assembly?.blank).toEqual({ mode: 'mark', found: 3, hidden: 0, pending: 0 });
    expect(markedOf(snapshot)).toEqual(HIDDEN_12);
    expect(hiddenOf(snapshot)).toEqual([]);
    expect(await pdfFixtures(await saveSingle(service, root))).toEqual(PAIRS_24);
  });

  it('AE5: «Оставлять» — детектор не запускался, кэша нет, 24 страницы в файле', async () => {
    const { detector, calls } = counting();
    const { service, root } = await blankBacks('keep', { blankDetector: detector });

    const snapshot = service.snapshot();
    expect(snapshot.assembly?.blank).toEqual({ mode: 'keep', found: 0, hidden: 0, pending: 0 });
    expect(snapshot.assembly?.order.every((page) => page.blank === null)).toBe(true);
    expect(calls).toEqual([]);
    await expect(readdir(blankDirOf(root, snapshot))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await pdfFixtures(await saveSingle(service, root))).toEqual(PAIRS_24);
  });

  it('AE3: бледный карандаш в лотке оборотов — не пусто, страница в PDF', async () => {
    const { service, root } = await connect(SCENARIOS['blank-pencil']);
    unwrap(await service.setBlankMode('hide'));
    await scanned(service, 3, 3);
    await untilScored(() => service.snapshot());

    expect(service.snapshot().assembly?.blank).toEqual({
      mode: 'hide',
      found: 0,
      hidden: 0,
      pending: 0,
    });
    expect(await pdfFixtures(await saveSingle(service, root))).toEqual([
      1,
      4,
      2,
      'pencil-faint-gray-300',
      3,
      6,
    ]);
  });

  it('AE6: пометка «не пустая» возвращает страницу в файл и переживает перезапуск; «Вернуть» снимает', async () => {
    const { service, root, restart } = await blankBacks('hide');

    unwrap(await service.setEdits({ ...EMPTY_EDITS, notBlank: [backOf(4)] }, {}));
    let snapshot = service.snapshot();
    expect(snapshot.assembly?.blank).toMatchObject({ found: 2, hidden: 2 });
    expect(hiddenOf(snapshot)).toEqual([backOf(9), backOf(12)]);
    expect(snapshot.assembly?.order.find((page) => page.key === backOf(4))?.blank).toBeNull();
    expect(snapshot.assembly?.hasEdits).toBe(true);

    const second = await restart();
    snapshot = second.snapshot();
    expect(snapshot.session?.edits.notBlank).toEqual([backOf(4)]);
    await untilScored(() => second.snapshot());
    expect(hiddenOf(second.snapshot())).toEqual([backOf(9), backOf(12)]);
    const pdf = await pdfFixtures(await saveSingle(second, root));
    expect(pdf).toHaveLength(22);
    expect(pdf[7]).toBe(BLANK);

    unwrap(await second.setEdits(EMPTY_EDITS, {}));
    expect(hiddenOf(second.snapshot())).toEqual(HIDDEN_12);
  });

  it('AE11: кэш оценок удалён → после перезапуска оценки идут заново и совпадают; до прихода — ничего не скрыто', async () => {
    const { service, root, restart } = await blankBacks('hide');
    const blankDir = blankDirOf(root, service.snapshot());
    await rm(blankDir, { recursive: true, force: true });

    const { detector, calls } = counting(150);
    const second = await restart({ blankDetector: detector });
    // Открытие без кэша: вердиктов нет — ничего не скрыто, оценки в ожидании (renderer в это
    // время держит `merge` или покажет тост поздних оценок).
    const opened = second.snapshot();
    expect(opened.assembly?.blank).toEqual({ mode: 'hide', found: 0, hidden: 0, pending: 12 });
    expect(keysOf(opened)).toHaveLength(24);
    expect(hiddenOf(opened)).toEqual([]);

    await untilScored(() => second.snapshot());
    expect(hiddenOf(second.snapshot())).toEqual(HIDDEN_12);
    expect(calls).toHaveLength(12);
    expect(await readdir(blankDir)).toHaveLength(12);
    // Третий запуск — из кэша, детектор молчит.
    const third = await restart({ blankDetector: counting().detector });
    expect(third.snapshot().assembly?.blank).toEqual({
      mode: 'hide',
      found: 3,
      hidden: 3,
      pending: 0,
    });
  });

  it('«Остановить» на проходе оборотов → заново: оценки у новых страниц, отброшенные забыты, детектор по разу на страницу', async () => {
    const { detector, calls } = counting();
    const { service, emulator } = await connect(
      { ...SCENARIOS['blank-backs'], pageDelayMs: 60 },
      { blankDetector: detector },
    );
    unwrap(await service.setBlankMode('hide'));
    await scanned(service, 12);

    // Проход оборотов остановлен после второй страницы (первая — пустой скан листа 12).
    const backs = service.startPass(null);
    await until(() => service.snapshot().pass?.pages === 2);
    expect(await service.stopPass()).toEqual({ ok: true, value: undefined });
    expect(unwrap(await backs)).toMatchObject({ end: 'stopped' });
    const stopped = service.snapshot();
    expect(stopped.session?.passes.map((pass) => pass.kind)).toEqual(['fronts']);
    expect(stopped.assembly?.blank).toEqual({ mode: 'hide', found: 0, hidden: 0, pending: 0 });
    const scoredBeforeStop = calls.length;
    expect(scoredBeforeStop).toBeLessThanOrEqual(2);

    // Новый проход оборотов (№3) — лоток заново: все 12 оценены, три скрыты.
    emulator.reloadTray(SCENARIOS['blank-backs'].trays[1]);
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 12 });
    await untilScored(() => service.snapshot());
    const snapshot = service.snapshot();
    expect(snapshot.assembly?.blank).toEqual({ mode: 'hide', found: 3, hidden: 3, pending: 0 });
    expect(hiddenOf(snapshot)).toEqual(['p03-s01-0009', 'p03-s01-0004', 'p03-s01-0001']);
    expect(calls.length).toBe(scoredBeforeStop + 12);
    // Повторных оценок нет.
    await delay(200);
    expect(calls.length).toBe(scoredBeforeStop + 12);
  });

  it('AE8: документ из одних скрытых — отказ `documentBlank` с номерами до записи, файлов нет; оценки идут — `blankPending`', async () => {
    const { service, root } = await blankBacks('hide');
    const folder = join(root, 'выход');
    await mkdir(folder, { recursive: true });

    // Разрезы перед оборотом листа 4 и за ним: документ 2 — только скрытая страница.
    const position = keysOf(service.snapshot()).indexOf(backOf(4));
    unwrap(
      await service.setEdits(
        { ...EMPTY_EDITS, cuts: [position, position + 1], names: ['', 'Приложение', ''] },
        {},
      ),
    );
    expect(service.snapshot().assembly?.documents.map((doc) => doc.count)).toEqual([7, 1, 16]);
    expect(
      await service.saveDocuments(folder, {
        mode: 'separate',
        names: ['a', 'b', 'c'],
        retry: false,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'documentBlank', documents: '2' } },
    });
    expect(await readdir(folder)).toEqual([]);
    // Одним файлом — можно: показанные есть.
    expect(await pdfFixtures(await saveSingle(service, root))).toEqual(PAIRS_21);

    // Оценки ещё идут (медленный детектор): запись отклонена с числом, после прихода — пишется.
    const slow = await connect(SCENARIOS['blank-pencil'], {
      blankDetector: counting(400).detector,
    });
    unwrap(await slow.service.setBlankMode('hide'));
    await scanned(slow.service, 3, 3);
    const pending = slow.service.snapshot().assembly?.blank.pending ?? 0;
    expect(pending).toBeGreaterThan(0);
    expect(
      await slow.service.saveDocuments(folder, { mode: 'single', names: ['x'], retry: false }),
    ).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'blankPending', pending } },
    });
    expect(await pdfFixtures(await saveSingle(slow.service, slow.root))).toHaveLength(6);
  });

  describe('AE7: наборы с пустыми (замятие на последнем обороте)', () => {
    it('в наборах пустые помечены, не скрыты; «Оставить как есть» → удалить лицо → «Собрать» → скрыто 2', async () => {
      const { service, root } = await connect(SCENARIOS['blank-sets']);
      unwrap(await service.setBlankMode('hide'));
      await scanned(service, 12);
      expect(await service.startPass(null)).toMatchObject({
        ok: true,
        value: { end: 'interrupted', pages: 11 },
      });
      await untilScored(() => service.snapshot());

      let snapshot = service.snapshot();
      expect(snapshot.assembly?.report).toMatchObject({ mode: 'sets', fronts: 12, backs: 11 });
      // Пустые у листов 9 и 4 — поданы 4-м и 9-м; в наборах — метка, не скрытие (R19 M3.6).
      expect(snapshot.assembly?.blank).toEqual({ mode: 'hide', found: 2, hidden: 0, pending: 0 });
      expect(markedOf(snapshot)).toEqual([back(9), back(4)]);
      expect(hiddenOf(snapshot)).toEqual([]);

      unwrap(await service.acceptPass());
      unwrap(await service.setEdits({ ...EMPTY_EDITS, deleted: [front(12)] }, {}));
      expect(service.snapshot().assembly?.sets).toEqual({ fronts: 11, backs: 11, divider: 11 });
      unwrap(await service.assemble());
      snapshot = service.snapshot();
      expect(snapshot.assembly?.report.mode).toBe('assembled');
      expect(snapshot.assembly?.blank).toEqual({ mode: 'hide', found: 2, hidden: 2, pending: 0 });
      expect(hiddenOf(snapshot)).toEqual([back(9), back(4)]);
      const pdf = await pdfFixtures(await saveSingle(service, root));
      expect(pdf).toHaveLength(20);
      expect(pdf).not.toContain(BLANK);
    });

    it('«+ Добавить» в группу оборотов: добавленный оборот оценки не получает и после сборки остаётся в файле', async () => {
      const { service, root } = await connect(SCENARIOS['blank-sets']);
      unwrap(await service.setBlankMode('hide'));
      await scanned(service, 12);
      await service.startPass(null);
      unwrap(await service.acceptPass());
      await untilScored(() => service.snapshot());

      // Недостающий оборот листа 1 — пустой скан «Одним листом» в конец группы оборотов.
      expect(unwrap(await service.startPass({ kind: 'added', after: back(11) }))).toMatchObject({
        end: 'completed',
        pages: 1,
      });
      await untilScored(() => service.snapshot());
      let snapshot = service.snapshot();
      expect(snapshot.assembly?.sets).toEqual({ fronts: 12, backs: 12, divider: 12 });
      const added = snapshot.assembly?.order.find((page) => page.key === 'p03-s01-0001');
      expect(added).toMatchObject({ addedSet: 1, blank: null });
      expect(snapshot.assembly?.blank).toEqual({ mode: 'hide', found: 2, hidden: 0, pending: 0 });

      unwrap(await service.assemble());
      snapshot = service.snapshot();
      expect(snapshot.assembly?.blank).toEqual({ mode: 'hide', found: 2, hidden: 2, pending: 0 });
      expect(
        snapshot.assembly?.order.find((page) => page.key === 'p03-s01-0001')?.blank,
      ).toBeNull();
      const pdf = await pdfFixtures(await saveSingle(service, root));
      expect(pdf).toHaveLength(22);
      // Добавленный пустой скан — в файле (детектор не трогает добавленные наборы, KTD9).
      expect(pdf.filter((page) => page === BLANK)).toHaveLength(1);
    });

    it('«Досканировать остаток» уравнивает проходы: пары, два оборота скрыты без сборки', async () => {
      // Без третьего лотка: досканирование — следующее задание, ему и достался бы `[BLANK]`.
      const { service, emulator, root } = await connect({
        ...SCENARIOS['blank-sets'],
        trays: SCENARIOS['blank-sets'].trays.slice(0, 2),
      });
      unwrap(await service.setBlankMode('hide'));
      await scanned(service, 12);
      await service.startPass(null);

      emulator.clearJam();
      emulator.reloadTray([13]);
      expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 1 });
      await untilScored(() => service.snapshot());
      const snapshot = service.snapshot();
      expect(snapshot.assembly?.report).toMatchObject({ mode: 'pairs', fronts: 12, backs: 12 });
      expect(snapshot.assembly?.blank).toEqual({ mode: 'hide', found: 2, hidden: 2, pending: 0 });
      expect(hiddenOf(snapshot)).toEqual([back(9), back(4)]);
      expect(await pdfFixtures(await saveSingle(service, root))).toHaveLength(22);
    });
  });

  it('режим сессии заморожен: смена настройки после первого прохода не меняет сессию', async () => {
    const { service } = await connect(SCENARIOS['blank-backs']);
    unwrap(await service.setBlankMode('hide'));
    await scanned(service, 12);
    unwrap(await service.setBlankMode('keep'));
    await scanned(service, 12);
    await untilScored(() => service.snapshot());

    const snapshot = service.snapshot();
    expect(snapshot.blankMode).toBe('keep');
    expect(snapshot.session?.blankMode).toBe('hide');
    expect(snapshot.assembly?.blank).toMatchObject({ mode: 'hide', hidden: 3 });
  });

  describe('B-18: оценки пустоты и закрытие каталога сессии', () => {
    it('«Новое сканирование» во время оценок — каталога derived закрытой сессии нет и он не появляется позже', async () => {
      const { service, root } = await connect(SCENARIOS['blank-backs'], {
        blankDetector: counting(300).detector,
      });
      unwrap(await service.setBlankMode('hide'));
      await scanned(service, 12, 12);
      const snapshot = service.snapshot();
      const derivedDir = join(layoutOf(root).derivedDir, snapshot.session?.id ?? '');
      expect(snapshot.assembly?.blank.pending ?? 0).toBeGreaterThan(0);

      unwrap(await service.closeSession());

      expect(service.snapshot().session).toBeNull();
      await expect(readdir(derivedDir)).rejects.toMatchObject({ code: 'ENOENT' });
      // Оценка в полёте не догоняет закрытие: каталог не создаётся заново и спустя время.
      await delay(700);
      await expect(readdir(derivedDir)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('закрытие не удалось (каталог занят) — отменённые оценки идут заново, pending возвращается к 0, запись не заблокирована', async () => {
      const emulator = await startTestEmulator({ scenario: SCENARIOS['blank-backs'] });
      const connected: ConnectedScanner = unwrap(
        await probeScanner({ ...emulator, fingerprint: null }),
      );
      const root = await makeTempDataRoot();
      const { sessionDir } = layoutOf(root);
      let failRename = false;
      const { fs } = interceptFs<StorageFs>(realStorageFs, (call) => {
        if (failRename && call.op === 'rename' && call.path === sessionDir) {
          throw fsError('EPERM');
        }
      });
      const service = await openPassService(root, {
        ...OPTIONS,
        fs,
        blankDetector: counting(300).detector,
      });
      await service.useScanner(connected);
      unwrap(await service.setBlankMode('hide'));
      await scanned(service, 12, 12);
      expect(service.snapshot().assembly?.blank.pending ?? 0).toBeGreaterThan(0);

      failRename = true;
      expect(await service.closeSession()).toMatchObject({
        ok: false,
        error: { code: 'sessionCloseFailed' },
      });
      failRename = false;

      await untilScored(() => service.snapshot());
      expect(service.snapshot().assembly?.blank).toMatchObject({ pending: 0, found: 3 });
      expect(await pdfFixtures(await saveSingle(service, root))).toEqual(PAIRS_21);
    });
  });
});
