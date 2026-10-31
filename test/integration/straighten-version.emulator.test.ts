import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_EDITS } from '../../src/shared';
import type { ScanJobLimits } from '../../src/core/escl/scan-job';
import { inlineImageWorker } from '../../src/core/image/image-worker';
import type { PassServiceOptions } from '../../src/core/scan/pass-service';
import { layoutOf } from '../../src/core/storage/layout';
import { realStorageFs } from '../../src/core/storage/storage-fs';
import { keyOf } from '../support/assembly';
import { fsError, interceptFs } from '../support/intercept-fs';
import { connectService, scanned } from '../support/pass-service';
import { unwrap } from '../support/result';
import { journalOnDisk } from '../support/session-store';
import {
  jpegsIn,
  sessionIdOf,
  straightJpegOf,
  straightRecordOf,
  streamsOf,
} from '../support/straighten';
import { SKEW_DETECTOR_VERSION } from '../../src/core/detect/skew';
import { untilStraightened } from '../support/until';

// Смена версии геометрии на всей цепочке (план M6, U9; AE13, AE14; KTD-6, KTD-8, KTD-11):
// сессия «вчерашнего» приложения с файлами и записями версии 1 открыта приложением версии 2.
// Прежний выправленный вид показан сразу и уходит в файл; сохранение не отказывает; пересчёт
// фоном пишет версию 2 и убирает прежнюю; откат по ключу на месте; журнал не меняется; повтор
// пакета после пересчёта — «данные изменились» (дайджест по версиям). Версия подменяется
// модулем: продуктовая — 1, и прежних версий у неё нет; «вчерашняя» сессия получается из
// сегодняшней переименованием файлов и записей в версию 1.

vi.mock('../../src/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared')>()),
  STRAIGHTEN_GEOMETRY_VERSION: 2,
}));

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

const F = (index: number): string => keyOf(1, index);

interface StraightRecord {
  readonly v: number;
  readonly detector: number;
  readonly file: { readonly name: string; readonly bytes: number };
}
const D = SKEW_DETECTOR_VERSION;
interface SkewRecord {
  readonly v: { readonly geometry: number; readonly detector: number };
}

/** Комплект страницы на диске — как от приложения с версией геометрии 1. */
async function downgrade(straight: string, skew: string, key: string): Promise<void> {
  await rename(join(straight, straightJpegOf(key, 2)), join(straight, straightJpegOf(key, 1)));
  const record = JSON.parse(
    await readFile(join(straight, straightRecordOf(key, 2)), 'utf8'),
  ) as StraightRecord;
  await rm(join(straight, straightRecordOf(key, 2)));
  await writeFile(
    join(straight, straightRecordOf(key, 1)),
    JSON.stringify({ ...record, v: 1, file: { ...record.file, name: straightJpegOf(key, 1) } }),
  );
  const measure = JSON.parse(await readFile(join(skew, `${key}.json`), 'utf8')) as SkewRecord;
  await writeFile(
    join(skew, `${key}.json`),
    JSON.stringify({ ...measure, v: { ...measure.v, geometry: 1 } }),
  );
}

describe('смена версии геометрии на эмуляторе (U9, AE13)', () => {
  it('прежняя версия показана и сохраняется без отказа; пересчёт фоном, прежние файлы убраны, откат и журнал на месте; повтор пакета после пересчёта — batchStale', async () => {
    let failSecond = false;
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (failSecond && call.op === 'rename' && call.to?.endsWith('Б.pdf') === true) {
        throw fsError('EIO');
      }
    });
    const { root, service, restart } = await connectService(
      { trays: [['fan-text-gray-300', 'fan-table-gray-300']] },
      OPTIONS,
      { imageWorker: inlineImageWorker(), fs },
    );
    await scanned(service, 2);
    await untilStraightened(() => service.snapshot());
    const sessionId = sessionIdOf(service);
    const straight = join(layoutOf(root).derivedDir, sessionId, 'straight');
    const skew = join(layoutOf(root).derivedDir, sessionId, 'skew');
    expect(await jpegsIn(straight)).toEqual([straightJpegOf(F(1), 2), straightJpegOf(F(2), 2)]);
    // Откат второй страницы и два документа — журнал «вчерашней» сессии.
    unwrap(
      await service.setEdits(
        { ...EMPTY_EDITS, keepOriginal: [F(2)], cuts: [1], names: ['', ''] },
        {},
      ),
    );
    const journalBefore = await journalOnDisk(root);
    await service.settleDerived();

    await downgrade(straight, skew, F(1));
    await downgrade(straight, skew, F(2));
    const firstV1 = await readFile(join(straight, straightJpegOf(F(1), 1)));

    const again = await restart();
    // Сразу после открытия: прежний вид без «ждёт», откат на месте.
    expect(again.snapshot().assembly?.order.map((page) => page.straighten)).toEqual([
      { status: 'straightened', reason: null, version: 1, detector: D, recalc: 'pending' },
      { status: 'kept', reason: null, version: 1, detector: D, recalc: 'pending' },
    ]);
    expect(again.snapshot().assembly?.straighten.pending).toBe(0);

    // Сохранение не отказывает и берёт прежний файл; второй документ падает — для повтора.
    const folder = join(root, 'выход');
    await mkdir(folder, { recursive: true });
    const request = { mode: 'separate', names: ['А', 'Б'], retry: false } as const;
    failSecond = true;
    expect(await again.saveDocuments(folder, request)).toMatchObject({
      ok: true,
      value: { failed: [{ index: 1 }] },
    });
    failSecond = false;
    expect((await streamsOf(join(folder, 'А.pdf')))[0]?.equals(firstV1)).toBe(true);

    // Пересчёт фоном: новая версия записана, прежняя убрана; статусы те же, версия — 2.
    await expect
      .poll(() => jpegsIn(straight), { timeout: 40_000, interval: 100 })
      .toEqual([straightJpegOf(F(1), 2), straightJpegOf(F(2), 2)]);
    await untilStraightened(() => again.snapshot());
    expect(again.snapshot().assembly?.order.map((page) => page.straighten)).toEqual([
      { status: 'straightened', reason: null, version: 2, detector: D, recalc: null },
      { status: 'kept', reason: null, version: 2, detector: D, recalc: null },
    ]);
    expect(await journalOnDisk(root)).toEqual(journalBefore);

    // AE14: файл первой страницы сменился между попытками — повтор отклонён, пакет заново.
    expect(await again.saveDocuments(folder, { ...request, retry: true })).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'batchStale' } },
    });
    expect(await again.saveDocuments(folder, request)).toMatchObject({
      ok: true,
      value: { failed: [], written: [{ fileName: 'А (2).pdf' }, { fileName: 'Б.pdf' }] },
    });
    expect(
      (await streamsOf(join(folder, 'А (2).pdf')))[0]?.equals(
        await readFile(join(straight, straightJpegOf(F(1), 2))),
      ),
    ).toBe(true);
    expect(
      (await streamsOf(join(folder, 'Б.pdf')))[0]?.equals(
        await readFile(join(layoutOf(root).pagesDir, `${F(2)}.jpg`)),
      ),
    ).toBe(true);
    await again.settleDerived();
  }, 120_000);
});
