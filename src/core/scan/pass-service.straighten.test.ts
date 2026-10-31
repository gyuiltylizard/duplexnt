import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_EDITS,
  fail,
  skewProfileOf,
  STRAIGHTEN_GEOMETRY_VERSION,
  type BlankMode,
  type SkewMeasure,
  type SkewOutcome,
  type StraightenMode,
  type StraightenStatus,
} from '@shared';
import { pageFixture, pageFixtureNumberOf, pdfImageStreams } from '../../../test/support/fixtures';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import { stubWorker } from '../../../test/support/image-worker';
import { unwrap } from '../../../test/support/result';
import { until } from '../../../test/support/until';
import type { BlankDetector } from '../detect/blank';
import { layoutOf } from '../storage/layout';
import { realStorageFs } from '../storage/storage-fs';
import { openPassService, type PassService } from './pass-service';

// Измерение перекоса в службе прохода (план M6, U5; R6, KTD-4, KTD-12) и статусы, гарды и
// снимок на сохранение (U12; KTD-8, KTD-9): исполнитель измерения подставной — решает по номеру
// страницы-фикстуры, коррекция настоящая; детектор пустоты тоже подставной; страницы настоящие
// JPEG устройства. Настоящий детектор на сканах — `test/integration/skew-scores.test.ts`,
// проход с измерением по ходу — `test/integration/straighten.emulator.test.ts`.

const SESSION = 'a1b2c3d4e5f60718';
const F = (index: number): string => `p01-s01-${String(index).padStart(4, '0')}`;
const B = (index: number): string => `p02-s01-${String(index).padStart(4, '0')}`;
const A = (index: number): string => `p03-s01-${String(index).padStart(4, '0')}`;

interface Seed {
  readonly fronts: number;
  readonly backs?: number;
  /** Односторонний добавленный набор после первой лицевой. */
  readonly added?: number;
  readonly blankMode?: BlankMode;
  readonly straighten?: StraightenMode;
  readonly notBlank?: readonly string[];
  /** Ключи, чьи файлы не пишутся: потерянные страницы. */
  readonly lost?: readonly string[];
}

/** Сессия на диске (журнал v8): лица — фикстуры 1..n, обороты — 11.., добавленные — 21.. */
async function seedSession(root: string, seed: Seed): Promise<void> {
  const layout = layoutOf(root);
  await mkdir(layout.pagesDir, { recursive: true });
  const passes = [
    { number: 1, kind: 'fronts', pages: seed.fronts, from: 1, after: null },
    { number: 2, kind: 'backs', pages: seed.backs ?? 0, from: 11, after: null },
    { number: 3, kind: 'added', pages: seed.added ?? 0, from: 21, after: F(1) },
  ].filter((pass) => pass.pages > 0);
  await writeFile(
    layout.journalFile,
    JSON.stringify({
      version: 8,
      sessionId: SESSION,
      nextPass: 4,
      passes: passes.map((pass) => ({
        number: pass.number,
        accepted: false,
        origin: null,
        nextSegment: 2,
        segments: [{ number: 1, state: 'completed', pageCount: pass.pages }],
        rotate180: false,
        kind: pass.kind,
        after: pass.after,
        pair: null,
        backsDecision: null,
      })),
      deletions: [],
      backsDeclined: false,
      saved: false,
      edits: { ...EMPTY_EDITS, notBlank: seed.notBlank ?? [] },
      assembled: null,
      blankMode: seed.blankMode ?? 'hide',
      straighten: seed.straighten ?? 'auto',
    }),
  );
  for (const pass of passes) {
    for (let index = 1; index <= pass.pages; index += 1) {
      const key = `p${String(pass.number).padStart(2, '0')}-s01-${String(index).padStart(4, '0')}`;
      if (!(seed.lost ?? []).includes(key)) {
        await writeFile(join(layout.pagesDir, `${key}.jpg`), pageFixture(pass.from + index - 1));
      }
    }
  }
}

const measureOf = (outcome: SkewOutcome): SkewMeasure => ({
  outcome,
  geometryVersion: STRAIGHTEN_GEOMETRY_VERSION,
  profile:
    outcome === 'unmeasurable'
      ? null
      : skewProfileOf([
          { u: 0.2, theta: 0 },
          { u: 0.8, theta: 0.6 },
        ]),
  cause: outcome === 'unmeasurable' ? 'content' : null,
  basis: outcome === 'unmeasurable' ? null : 'whole',
  contrast: null,
  fanMm: null,
  bands: [],
  bandMm: 30,
  coverage: 1,
  shapeResidual: null,
  reason: null,
});

/**
 * Подставной исполнитель: фикстуры с номерами из `skewed` — «выправлять», остальные — «ровно»;
 * `gated` держит ответы до `release`; `calls` — номера измеренных фикстур.
 */
function workerOf(skewed: readonly number[], options: { gated?: boolean } = {}) {
  const stub = stubWorker({
    ...options,
    measure: (bytes) =>
      Promise.resolve(
        measureOf(skewed.includes(pageFixtureNumberOf(bytes)) ? 'willStraighten' : 'level'),
      ),
  });
  const calls = {
    get length(): number {
      return stub.calls.length;
    },
    toArray: (): number[] => stub.calls.map(pageFixtureNumberOf),
  };
  return { worker: stub.worker, calls, release: stub.release };
}

/** Детектор пустоты: фикстуры с номерами из `blank` — пусто. */
const blankDetectorOf =
  (blank: readonly number[]): BlankDetector =>
  (bytes) =>
    Promise.resolve(blank.includes(pageFixtureNumberOf(bytes)) ? 0 : 0.03);

const skewDir = (root: string): string => join(layoutOf(root).derivedDir, SESSION, 'skew');
const straightDir = (root: string): string => join(layoutOf(root).derivedDir, SESSION, 'straight');
const skewFiles = async (root: string): Promise<string[]> =>
  (await readdir(skewDir(root)).catch(() => [])).filter((name) => name.endsWith('.json')).sort();

describe('служба прохода: измерение перекоса (M6, U5)', () => {
  it('«выравнивать»: лица, добавленные и непустые обороты измеряются после открытия; скрытый пустой — нет; каждый исход — файл в skew/', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, { fronts: 2, backs: 2, added: 1 });
    const { worker, calls } = workerOf([1, 12]);
    const seen: number[] = [];
    const service = await openPassService(root, {
      imageWorker: worker,
      blankDetector: blankDetectorOf([11]),
      onChange: (seq) => seen.push(seq),
    });

    await until(() => calls.length === 4);
    await expect.poll(() => skewFiles(root)).toHaveLength(4);

    expect(calls.toArray().sort((p, q) => p - q)).toEqual([1, 2, 12, 21]);
    expect(await skewFiles(root)).toEqual(
      [`${F(1)}.json`, `${F(2)}.json`, `${B(2)}.json`, `${A(1)}.json`].sort(),
    );
    // Каждый новый вердикт — снимок.
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(service.snapshot().assembly?.blank.hidden).toBe(1);
  });

  it('«Это не пустая страница» ставит скрытый оборот под измерение', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, { fronts: 1, backs: 1 });
    const { worker, calls } = workerOf([]);
    const service = await openPassService(root, {
      imageWorker: worker,
      blankDetector: blankDetectorOf([11]),
    });
    await until(() => service.snapshot().assembly?.blank.pending === 0);
    await until(() => calls.length === 1);
    expect(calls.toArray()).toEqual([1]);

    expect(await service.setEdits({ ...EMPTY_EDITS, notBlank: [B(1)] }, {})).toMatchObject({
      ok: true,
    });

    await until(() => calls.length === 2);
    expect(calls.toArray()).toEqual([1, 11]);
  });

  it('«не выравнивать»: исполнитель не вызывается, каталога skew/ нет; потерянная страница не измеряется', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, { fronts: 2, backs: 1, straighten: 'off' });
    const { worker, calls } = workerOf([1]);
    const service = await openPassService(root, {
      imageWorker: worker,
      blankDetector: blankDetectorOf([]),
    });
    await until(() => service.snapshot().assembly?.blank.pending === 0);
    expect(calls.toArray()).toEqual([]);
    expect(await skewFiles(root)).toEqual([]);

    const lostRoot = await makeTempDataRoot();
    await seedSession(lostRoot, { fronts: 2, lost: [F(2)] });
    const lost = workerOf([]);
    await openPassService(lostRoot, { imageWorker: lost.worker });
    await until(() => lost.calls.length === 1);
    expect(lost.calls.toArray()).toEqual([1]);
  });

  it('перезапуск с кэшем: исполнитель не вызывается, кэш прочитан при открытии', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, { fronts: 2, blankMode: 'keep' });
    const first = workerOf([1]);
    await openPassService(root, { imageWorker: first.worker });
    await expect.poll(() => skewFiles(root)).toHaveLength(2);

    const again = workerOf([1]);
    const service = await openPassService(root, { imageWorker: again.worker });
    await service.setEdits(EMPTY_EDITS, {});
    expect(again.calls.toArray()).toEqual([]);
  });

  it('«Новая пачка» посреди измерения отменяет его: производное удалено и не пересоздано, исполнитель отпущен позже', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, { fronts: 2, blankMode: 'keep' });
    const { worker, calls, release } = workerOf([1], { gated: true });
    const service = await openPassService(root, { imageWorker: worker });
    await until(() => calls.length === 2);

    expect(await service.closeSession()).toEqual({ ok: true, value: undefined });
    release();
    await service.settleDerived();

    expect(await readdir(layoutOf(root).derivedDir).catch(() => [])).toEqual([]);
    expect(service.snapshot().session).toBeNull();
  });
});

const SINGLE = { mode: 'single', names: ['Документ'], retry: false } as const;

async function folderIn(root: string, name = 'выход'): Promise<string> {
  const folder = join(root, name);
  await mkdir(folder, { recursive: true });
  return folder;
}

const statusesOf = (service: PassService): Record<string, StraightenStatus> =>
  Object.fromEntries(
    (service.snapshot().assembly?.order ?? []).map((page) => [page.key, page.straighten.status]),
  );

const untilStraightened = (service: PassService): Promise<void> =>
  until(() => service.snapshot().assembly?.straighten.pending === 0);

/** Потоки изображений PDF по пути. */
const streamsOf = async (path: string): Promise<Buffer[]> =>
  (await pdfImageStreams(await readFile(path))).map((stream) => Buffer.from(stream.getContents()));

describe('служба прохода: статусы, гарды и снимок на сохранение (M6, U12)', () => {
  /** Три лица: 1 — «выправлять» (исход — настоящая коррекция), 2 — «ровно», 3 — «не померить». */
  const measureOfFixture = (bytes: Uint8Array): Promise<SkewMeasure> => {
    const number = pageFixtureNumberOf(bytes);
    return Promise.resolve(
      measureOf(number === 1 ? 'willStraighten' : number === 2 ? 'level' : 'unmeasurable'),
    );
  };

  it('статусы по исходам; пока измерение идёт — отказ straightenPending с числом; потом PDF: выправленная — другой поток, ровная — байт в байт; повтор — те же потоки', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await seedSession(root, { fronts: 3, blankMode: 'keep' });
    const gated = stubWorker({ gated: true, measure: measureOfFixture });
    const service = await openPassService(root, { imageWorker: gated.worker });

    expect(service.snapshot().assembly?.straighten).toMatchObject({ pending: 3, total: 3 });
    expect(statusesOf(service)).toEqual({
      [F(1)]: 'pending',
      [F(2)]: 'pending',
      [F(3)]: 'pending',
    });
    expect(service.snapshot().straightenProgress).toEqual({ queued: 0, running: null });
    expect(await service.saveDocuments(folder, SINGLE)).toEqual(
      fail('sessionConflict', { pending: 3, reason: 'straightenPending' }),
    );
    expect(await readdir(folder)).toEqual([]);

    gated.release();
    await untilStraightened(service);
    expect(statusesOf(service)).toEqual({
      [F(1)]: 'straightened',
      [F(2)]: 'level',
      [F(3)]: 'unmeasurable',
    });
    const snapshot = service.snapshot();
    expect(snapshot.assembly?.order.map((page) => page.straighten.reason)).toEqual([
      null,
      null,
      'measure',
    ]);
    expect(snapshot.assembly?.straighten).toMatchObject({
      straightened: 1,
      level: 1,
      unmeasurable: 1,
      pending: 0,
      total: 3,
      reasons: { measure: 1 },
    });
    expect(snapshot.straightenProgress).toEqual({ queued: 0, running: null });

    const saved = unwrap(await service.saveDocuments(folder, SINGLE));
    expect(saved.failed).toEqual([]);
    const streams = await streamsOf(join(folder, 'Документ.pdf'));
    expect(streams).toHaveLength(3);
    expect(streams[0]?.equals(pageFixture(1))).toBe(false);
    expect(streams[0]?.equals(await readFile(join(straightDir(root), `${F(1)}.v1.jpg`)))).toBe(
      true,
    );
    expect(streams[1]?.equals(pageFixture(2))).toBe(true);
    expect(streams[2]?.equals(pageFixture(3))).toBe(true);
    expect(service.snapshot().session?.saved).toBe(true);

    // Повтор пакета даёт те же потоки: снимок берётся заново, файлы те же.
    const again = unwrap(await service.saveDocuments(folder, SINGLE));
    expect(again.written).toEqual([{ index: 0, fileName: 'Документ (2).pdf' }]);
    expect(await streamsOf(join(folder, 'Документ (2).pdf'))).toEqual(streams);
  });

  it('«Оставить оригинал»: статус kept, в PDF — исходник байт в байт, правка; «Вернуть» снимает; откат на ровной не действует', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await seedSession(root, { fronts: 2, blankMode: 'keep' });
    const service = await openPassService(root, {
      imageWorker: stubWorker({ measure: measureOfFixture }).worker,
    });
    await untilStraightened(service);
    expect(statusesOf(service)).toEqual({ [F(1)]: 'straightened', [F(2)]: 'level' });
    expect(service.snapshot().assembly?.hasEdits).toBe(false);

    expect(
      await service.setEdits({ ...EMPTY_EDITS, keepOriginal: [F(1), F(2), 'p09-s01-0001'] }, {}),
    ).toMatchObject({ ok: true });
    const kept = service.snapshot();
    expect(kept.session?.edits.keepOriginal).toEqual([F(1), F(2)]);
    expect(kept.assembly?.hasEdits).toBe(true);
    expect(statusesOf(service)).toEqual({ [F(1)]: 'kept', [F(2)]: 'level' });
    expect(kept.assembly?.straighten).toMatchObject({ straightened: 0, kept: 1, level: 1 });

    unwrap(await service.saveDocuments(folder, SINGLE));
    const streams = await streamsOf(join(folder, 'Документ.pdf'));
    expect(streams[0]?.equals(pageFixture(1))).toBe(true);
    expect(streams[1]?.equals(pageFixture(2))).toBe(true);

    // Откат переживает перезапуск; «Вернуть» (пустые правки) его снимает.
    const again = await openPassService(root, {
      imageWorker: stubWorker({ measure: measureOfFixture }).worker,
    });
    expect(statusesOf(again)).toEqual({ [F(1)]: 'kept', [F(2)]: 'level' });
    expect(await again.setEdits(EMPTY_EDITS, {})).toMatchObject({ ok: true });
    expect(statusesOf(again)).toEqual({ [F(1)]: 'straightened', [F(2)]: 'level' });
  });

  it('AE15: мало места — deferred «disk», сохранение не блокирует, страница уходит оригиналом', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await seedSession(root, { fronts: 2, blankMode: 'keep' });
    const service = await openPassService(root, {
      imageWorker: stubWorker({ measure: measureOfFixture }).worker,
      fs: { ...realStorageFs, freeBytes: () => Promise.resolve(0) },
    });
    await untilStraightened(service);

    expect(service.snapshot().assembly?.order.map((page) => page.straighten)).toEqual([
      { status: 'deferred', reason: 'disk', version: null, detector: null, recalc: null },
      { status: 'level', reason: null, version: null, detector: null, recalc: null },
    ]);
    expect(service.snapshot().assembly?.straighten).toMatchObject({
      deferred: 1,
      pending: 0,
      reasons: { disk: 1 },
    });
    expect(await readdir(straightDir(root)).catch(() => [])).toEqual([]);

    const saved = unwrap(await service.saveDocuments(folder, SINGLE));
    expect(saved.failed).toEqual([]);
    const streams = await streamsOf(join(folder, 'Документ.pdf'));
    expect(streams[0]?.equals(pageFixture(1))).toBe(true);
  });

  it('AE14: файл из снимка пропал между снимком и записью — сбой документа с причиной, не подмена оригиналом', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await seedSession(root, { fronts: 2, blankMode: 'keep' });
    const service = await openPassService(root, {
      imageWorker: stubWorker({ measure: measureOfFixture }).worker,
    });
    await untilStraightened(service);
    expect(statusesOf(service)[F(1)]).toBe('straightened');

    await rm(join(straightDir(root), `${F(1)}.v1.jpg`));

    const saved = unwrap(await service.saveDocuments(folder, SINGLE));
    expect(saved.written).toEqual([]);
    expect(saved.failed).toEqual([
      {
        index: 0,
        fileName: 'Документ.pdf',
        error: { code: 'pageUnavailable', details: { reason: 'straightened' } },
      },
    ]);
    expect(await readdir(folder)).toEqual([]);
    expect(service.snapshot().session?.saved).toBe(false);
  });

  it('закрытие сессии не состоялось: отменённые измерение и коррекция возобновляются, сохранение не залипает на straightenPending', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await seedSession(root, { fronts: 2, blankMode: 'keep' });
    const gated = stubWorker({ gated: true, measure: measureOfFixture });
    // Каталог сессии не переименовывается (EBUSY — как при открытом дескрипторе на Windows):
    // закрытие отказывает `sessionCloseFailed`, сессия остаётся рабочей (KTD-33).
    const sessionDir = layoutOf(root).sessionDir;
    const service = await openPassService(root, {
      imageWorker: gated.worker,
      retry: { ceilingMs: 0 },
      fs: {
        ...realStorageFs,
        rename: (from, to) =>
          from === sessionDir
            ? Promise.reject(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }))
            : realStorageFs.rename(from, to),
      },
    });
    await until(() => gated.started() >= 1);

    expect(await service.closeSession()).toMatchObject({
      ok: false,
      error: { code: 'sessionCloseFailed' },
    });
    expect(service.snapshot().session).not.toBeNull();
    // Отменённые измерения перезапущены (новый сигнал), исполнитель всё ещё держит ответы.
    expect(service.snapshot().assembly?.straighten.pending).toBe(2);

    gated.release();
    await untilStraightened(service);
    expect(statusesOf(service)).toEqual({ [F(1)]: 'straightened', [F(2)]: 'level' });
    expect(unwrap(await service.saveDocuments(folder, SINGLE)).failed).toEqual([]);
  });

  it('режим сессии «не выравнивать»: статусы null, сводка нулевая, прогресса нет; настройка меняется командой и помнится', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, { fronts: 1, straighten: 'off' });
    const service = await openPassService(root, {
      imageWorker: stubWorker({ measure: measureOfFixture }).worker,
    });

    expect(statusesOf(service)).toEqual({ [F(1)]: null });
    expect(service.snapshot().assembly?.straighten).toMatchObject({ mode: 'off', total: 0 });
    expect(service.snapshot().straightenProgress).toBeNull();

    const seqBefore = service.snapshot().seq;
    expect(await service.setStraightenMode('off')).toEqual({ ok: true, value: undefined });
    expect(service.snapshot().straightenMode).toBe('off');
    expect(service.snapshot().seq).toBeGreaterThan(seqBefore);
    // Открытая сессия заморожена, настройка — помнится.
    expect(service.snapshot().session?.straighten).toBe('off');
    expect((await openPassService(root)).snapshot().straightenMode).toBe('off');
  });
});
