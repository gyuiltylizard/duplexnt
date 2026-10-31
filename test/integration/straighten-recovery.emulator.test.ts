import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_EDITS } from '../../src/shared';
import type { ScanJobLimits } from '../../src/core/escl/scan-job';
import { inlineImageWorker, type ImageWorker } from '../../src/core/image/image-worker';
import type { PassService, PassServiceOptions } from '../../src/core/scan/pass-service';
import { layoutOf } from '../../src/core/storage/layout';
import { realStorageFs } from '../../src/core/storage/storage-fs';
import { keyOf } from '../support/assembly';
import { pageFixture } from '../support/fixtures';
import { stubWorker } from '../support/image-worker';
import { fsError, interceptFs } from '../support/intercept-fs';
import { connectService, saveSingle, scanned } from '../support/pass-service';
import { journalV7Of, pass, segment } from '../support/reconcile';
import { unwrap } from '../support/result';
import { journalOnDisk } from '../support/session-store';
import {
  jpegsIn,
  sessionIdOf,
  skewDirOf,
  statusesOf,
  straightDirOf,
  streamsOf,
} from '../support/straighten';
import { until, untilStraightened } from '../support/until';

// Восстановление и сбои выравнивания на эмуляторе (план M6, U9; AE8, AE9, AE10, AE14, AE15):
// частично потерянное производное, журнал прежней версии с открытым проходом, сохранение при
// незавершённом выравнивании, повтор пакета после правки, нехватка места и сбой коррекции.
// Настоящие сканы, настоящий исполнитель; полная потеря производного и закрытие посреди
// очереди (AE16) — `straighten.emulator.test.ts`, смена версии геометрии (AE13) —
// `straighten-version.emulator.test.ts`.

const FAST: Partial<ScanJobLimits> = {
  retryDelayMs: 5,
  busyCeilingMs: 200,
  notReadyCeilingMs: 2000,
  pageIdleTimeoutMs: 1500,
  pageDeadlineMs: 6000,
  deleteDeadlineMs: 300,
};

const OPTIONS = {
  jobLimits: FAST,
  minFreeBytes: 1,
  retry: { ceilingMs: 0 },
} satisfies PassServiceOptions;

const REAL = { imageWorker: inlineImageWorker() };
const SINGLE = { mode: 'single', names: ['Документ'], retry: false } as const;

const F = (index: number): string => keyOf(1, index);

const pageFileOf = (root: string, key: string): string =>
  join(layoutOf(root).pagesDir, `${key}.jpg`);

const marksOf = (service: PassService) =>
  (service.snapshot().assembly?.order ?? []).map((page) => page.straighten);

async function folderIn(root: string): Promise<string> {
  const folder = join(root, 'выход');
  await mkdir(folder, { recursive: true });
  return folder;
}

describe('выравнивание на эмуляторе: восстановление и сбои (U9)', () => {
  it('AE8: производное потеряно частично — недостающее досчитано, имеющееся не перезаписано; статусы, PDF и журнал те же', async () => {
    const { root, service, restart } = await connectService(
      { trays: [['fan-text-gray-300', 'photo-gray-300', 'fan-table-gray-300']] },
      OPTIONS,
      REAL,
    );
    await scanned(service, 3);
    await untilStraightened(() => service.snapshot());
    const sessionId = sessionIdOf(service);
    const skew = skewDirOf(root, sessionId);
    const straight = straightDirOf(root, sessionId);
    const statuses = statusesOf(service);
    expect(statuses).toEqual({
      [F(1)]: 'straightened',
      [F(2)]: 'unmeasurable',
      [F(3)]: 'straightened',
    });
    const pdfBefore = await streamsOf(await saveSingle(service, root));
    const journalBefore = await journalOnDisk(root);
    const keptSkew = await stat(join(skew, `${F(1)}.json`));
    const keptStraight = await stat(join(straight, `${F(1)}.v1.jpg`));

    // Теряются оценка фото и выправленный файл таблицы с записью; оценка и файл текста целы.
    await rm(join(skew, `${F(2)}.json`));
    await rm(join(straight, `${F(3)}.v1.jpg`));
    await rm(join(straight, `${F(3)}.v1.json`));

    const again = await restart();
    // Сразу после открытия: текст показан выправленным — файл есть; остальное досчитывается.
    expect(statusesOf(again)[F(1)]).toBe('straightened');
    await untilStraightened(() => again.snapshot());
    expect(statusesOf(again)).toEqual(statuses);
    expect((await stat(join(skew, `${F(1)}.json`))).mtimeMs).toBe(keptSkew.mtimeMs);
    expect((await stat(join(straight, `${F(1)}.v1.jpg`))).mtimeMs).toBe(keptStraight.mtimeMs);
    expect(await readdir(skew)).toContain(`${F(2)}.json`);
    expect(await jpegsIn(straight)).toEqual([`${F(1)}.v1.jpg`, `${F(3)}.v1.jpg`]);
    expect(await streamsOf(await saveSingle(again, root))).toEqual(pdfBefore);
    expect(await journalOnDisk(root)).toEqual(journalBefore);
    await again.settleDerived();
  }, 90_000);

  it('AE9: журнал v7 с открытым проходом — режим «не выравнивать», досканирование без измерений, пометок нет, PDF из исходников, журнал переписан в v8', async () => {
    const { root, service } = await connectService(
      { trays: [['fan-text-gray-300', 'fan-table-gray-300']] },
      OPTIONS,
      REAL,
      async (dataRoot, scanner) => {
        const layout = layoutOf(dataRoot);
        await mkdir(layout.pagesDir, { recursive: true });
        const origin = {
          scanner,
          params: { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' },
          pixelLimit: 5100 * 8400,
        };
        await writeFile(
          layout.journalFile,
          JSON.stringify(journalV7Of([pass(1, [segment(1, 'running', 2)], { origin })])),
        );
        await writeFile(pageFileOf(dataRoot, F(1)), pageFixture(1));
        await writeFile(pageFileOf(dataRoot, F(2)), pageFixture(2));
      },
    );
    expect(service.snapshot().session?.straighten).toBe('off');
    expect(service.snapshot().canResume).toBe(true);

    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 2 });

    const keys = [F(1), F(2), 'p01-s02-0001', 'p01-s02-0002'];
    expect(service.snapshot().session?.passes[0]?.pages.map((page) => page.key)).toEqual(keys);
    expect(statusesOf(service)).toEqual(Object.fromEntries(keys.map((key) => [key, null])));
    expect(service.snapshot().straightenProgress).toBeNull();
    expect(service.snapshot().assembly?.straighten).toMatchObject({ mode: 'off', total: 0 });
    const derived = join(layoutOf(root).derivedDir, sessionIdOf(service));
    const derivedEntries = await readdir(derived).catch(() => []);
    expect(derivedEntries).not.toContain('skew');
    expect(derivedEntries).not.toContain('straight');

    const streams = await streamsOf(await saveSingle(service, root));
    expect(streams).toHaveLength(4);
    for (const [index, key] of keys.entries()) {
      expect(streams[index]?.equals(await readFile(pageFileOf(root, key))), key).toBe(true);
    }
    const journal = await journalOnDisk(root);
    expect(journal.version).toBe(8);
    expect(journal.straighten).toBe('off');
  }, 60_000);

  it('AE10: сохранение при незавершённом выравнивании — отказ с числом; после завершения — файл из выправленных', async () => {
    const gated = stubWorker({ gated: true });
    const { root, service } = await connectService(
      { trays: [['fan-text-gray-300', 'fan-table-gray-300']] },
      OPTIONS,
      { imageWorker: gated.worker },
    );
    await scanned(service, 2);
    await until(() => gated.started() >= 2);
    expect(service.snapshot().assembly?.straighten.pending).toBe(2);

    expect(await service.saveDocuments(await folderIn(root), SINGLE)).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'straightenPending', pending: 2 } },
    });

    gated.release();
    await untilStraightened(() => service.snapshot());
    const straight = straightDirOf(root, sessionIdOf(service));
    const streams = await streamsOf(await saveSingle(service, root));
    expect(streams[0]?.equals(await readFile(join(straight, `${F(1)}.v1.jpg`)))).toBe(true);
    expect(streams[1]?.equals(await readFile(join(straight, `${F(2)}.v1.jpg`)))).toBe(true);
    await service.settleDerived();
  }, 60_000);

  it('AE14: повтор пакета после отката страницы между попытками — «данные изменились», пакет заново целиком', async () => {
    let failSecond = true;
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (failSecond && call.op === 'rename' && call.to?.endsWith('Б.pdf') === true) {
        throw fsError('EIO');
      }
    });
    const { root, service } = await connectService(
      { trays: [['fan-text-gray-300', 'fan-table-gray-300']] },
      OPTIONS,
      { ...REAL, fs },
    );
    await scanned(service, 2);
    await untilStraightened(() => service.snapshot());
    const straight = straightDirOf(root, sessionIdOf(service));
    unwrap(await service.setEdits({ ...EMPTY_EDITS, cuts: [1], names: ['', ''] }, {}));
    const folder = await folderIn(root);
    const request = { mode: 'separate', names: ['А', 'Б'], retry: false } as const;
    expect(await service.saveDocuments(folder, request)).toMatchObject({
      ok: true,
      value: { failed: [{ index: 1 }] },
    });

    // Между попытками — откат второй страницы: её файл в пакете стал бы другим.
    unwrap(
      await service.setEdits(
        { ...EMPTY_EDITS, cuts: [1], names: ['', ''], keepOriginal: [F(2)] },
        {},
      ),
    );
    failSecond = false;
    expect(await service.saveDocuments(folder, { ...request, retry: true })).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'batchStale' } },
    });
    expect((await readdir(folder)).sort()).toEqual(['А.pdf']);

    expect(await service.saveDocuments(folder, request)).toMatchObject({
      ok: true,
      value: { failed: [], written: [{ fileName: 'А (2).pdf' }, { fileName: 'Б.pdf' }] },
    });
    const first = await streamsOf(join(folder, 'А (2).pdf'));
    const second = await streamsOf(join(folder, 'Б.pdf'));
    expect(first[0]?.equals(await readFile(join(straight, `${F(1)}.v1.jpg`)))).toBe(true);
    expect(second[0]?.equals(await readFile(pageFileOf(root, F(2))))).toBe(true);
    await service.settleDerived();
  }, 60_000);

  it('AE15: мало места — отложена «disk», сохранение проходит оригиналом; место появилось, сессия открыта заново — выправлена', async () => {
    const gated = stubWorker({ gated: true });
    let free = Number.MAX_SAFE_INTEGER;
    const { root, service, restart } = await connectService(
      { trays: [['fan-text-gray-300', 'photo-gray-300']] },
      OPTIONS,
      {
        imageWorker: gated.worker,
        fs: { ...realStorageFs, freeBytes: () => Promise.resolve(free) },
      },
    );
    await scanned(service, 2);
    // Проход принят при свободном месте; коррекция застаёт том полным.
    free = 1;
    gated.release();
    await untilStraightened(() => service.snapshot());

    expect(marksOf(service)).toEqual([
      { status: 'deferred', reason: 'disk', version: null, detector: null, recalc: null },
      { status: 'unmeasurable', reason: 'measure', version: null, detector: null, recalc: null },
    ]);
    expect(service.snapshot().assembly?.straighten).toMatchObject({
      deferred: 1,
      pending: 0,
      reasons: { disk: 1, measure: 1 },
    });
    const straight = straightDirOf(root, sessionIdOf(service));
    expect(await jpegsIn(straight)).toEqual([]);
    const streams = await streamsOf(await saveSingle(service, root));
    expect(streams[0]?.equals(await readFile(pageFileOf(root, F(1))))).toBe(true);

    const again = await restart(REAL);
    await untilStraightened(() => again.snapshot());
    expect(statusesOf(again)[F(1)]).toBe('straightened');
    expect(await jpegsIn(straight)).toEqual([`${F(1)}.v1.jpg`]);
    await again.settleDerived();
  }, 60_000);

  it('AE15: сбой коррекции — отложена «fail», сохранение проходит оригиналом; при следующем открытии — выправлена', async () => {
    const failing: ImageWorker = {
      ...inlineImageWorker(),
      straighten: () => Promise.resolve(null),
    };
    const { root, service, restart } = await connectService(
      { trays: [['fan-text-gray-300', 'photo-gray-300']] },
      OPTIONS,
      { imageWorker: failing },
    );
    await scanned(service, 2);
    await untilStraightened(() => service.snapshot());

    expect(marksOf(service)[0]).toEqual({
      status: 'deferred',
      reason: 'fail',
      version: null,
      detector: null,
      recalc: null,
    });
    expect(service.snapshot().assembly?.straighten).toMatchObject({
      deferred: 1,
      pending: 0,
      reasons: { fail: 1 },
    });
    const streams = await streamsOf(await saveSingle(service, root));
    expect(streams[0]?.equals(await readFile(pageFileOf(root, F(1))))).toBe(true);

    const again = await restart(REAL);
    await untilStraightened(() => again.snapshot());
    expect(statusesOf(again)[F(1)]).toBe('straightened');
    await again.settleDerived();
  }, 60_000);
});
