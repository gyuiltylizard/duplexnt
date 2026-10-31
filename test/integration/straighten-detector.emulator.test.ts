import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_EDITS, type StraightenMark } from '../../src/shared';
import type { ScanJobLimits } from '../../src/core/escl/scan-job';
import { inlineImageWorker, type ImageWorker } from '../../src/core/image/image-worker';
import type { PassService, PassServiceOptions } from '../../src/core/scan/pass-service';
import { layoutOf, UNKNOWN_DETECTOR } from '../../src/core/storage/layout';
import { realStorageFs } from '../../src/core/storage/storage-fs';
import { keyOf } from '../support/assembly';
import { LEVEL_MEASURE } from '../support/image-worker';
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
import { untilStraightened } from '../support/until';

// Смена версии детектора при той же геометрии на всей цепочке (B-19; AE13, AE14; KTD-1…KTD-6
// плана): сессия «вчерашнего» приложения с парами прежнего детектора — или прежнего формата без
// детектора вовсе — открыта приложением с новым. Прежний выправленный вид показан сразу с
// признаком пересчёта и уходит в файл; сохранение не отказывает; пересчёт фоном пишет пару
// текущего детектора рядом и убирает прежнюю; откат по ключу на месте; журнал не меняется; повтор
// пакета после пересчёта — «данные изменились» (дайджест по детектору). Страница, которой новый
// детектор ставит «ровная», теряет пару и следует вердикту. Версия детектора подменяется модулем
// (число, не алгоритм): «вчерашняя» сессия получается из сегодняшней переименованием пар.

const NEXT = 99;
const PREVIOUS = NEXT - 1;

vi.mock('../../src/core/detect/skew', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/detect/skew')>()),
  SKEW_DETECTOR_VERSION: 99,
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
  readonly detector?: number;
  readonly file: { readonly name: string; readonly bytes: number };
}
interface SkewRecord {
  readonly v: { readonly geometry: number; readonly detector: number };
}

const marksOf = (service: PassService): StraightenMark[] =>
  service.snapshot().assembly?.order.map((page) => page.straighten) ?? [];

/**
 * Комплект страницы на диске — как от приложения с детектором `detector`: пара переименована,
 * запись и кэш оценок переписаны; у детектора «неизвестен» — прежний формат без поля и без `.d`.
 */
async function downgrade(
  straight: string,
  skew: string,
  key: string,
  detector: number,
): Promise<void> {
  const jpeg = straightJpegOf(key, 1, detector);
  await rename(join(straight, straightJpegOf(key, 1, NEXT)), join(straight, jpeg));
  const record = JSON.parse(
    await readFile(join(straight, straightRecordOf(key, 1, NEXT)), 'utf8'),
  ) as StraightRecord;
  await rm(join(straight, straightRecordOf(key, 1, NEXT)));
  const withoutDetector: Record<string, unknown> = { ...record };
  delete withoutDetector.detector;
  await writeFile(
    join(straight, straightRecordOf(key, 1, detector)),
    JSON.stringify({
      ...withoutDetector,
      ...(detector === UNKNOWN_DETECTOR ? {} : { detector }),
      file: { ...record.file, name: jpeg },
    }),
  );
  const measure = JSON.parse(await readFile(join(skew, `${key}.json`), 'utf8')) as SkewRecord;
  await writeFile(
    join(skew, `${key}.json`),
    JSON.stringify({ ...measure, v: { ...measure.v, detector: PREVIOUS } }),
  );
}

/** Сессия двух косых страниц, выправленных текущим детектором; вторая откачена, два документа. */
async function yesterday(detector: number, extra: Partial<PassServiceOptions> = {}) {
  const connected = await connectService(
    { trays: [['fan-text-gray-300', 'fan-table-gray-300']] },
    OPTIONS,
    { imageWorker: inlineImageWorker(), ...extra },
  );
  const { root, service } = connected;
  await scanned(service, 2);
  await untilStraightened(() => service.snapshot());
  const sessionId = sessionIdOf(service);
  const straight = join(layoutOf(root).derivedDir, sessionId, 'straight');
  const skew = join(layoutOf(root).derivedDir, sessionId, 'skew');
  expect(await jpegsIn(straight)).toEqual([
    straightJpegOf(F(1), 1, NEXT),
    straightJpegOf(F(2), 1, NEXT),
  ]);
  unwrap(
    await service.setEdits(
      { ...EMPTY_EDITS, keepOriginal: [F(2)], cuts: [1], names: ['', ''] },
      {},
    ),
  );
  const journal = await journalOnDisk(root);
  await service.settleDerived();
  await downgrade(straight, skew, F(1), detector);
  await downgrade(straight, skew, F(2), detector);
  const firstOld = await readFile(join(straight, straightJpegOf(F(1), 1, detector)));
  return { ...connected, straight, skew, journal, firstOld };
}

describe('смена версии детектора на эмуляторе (B-19)', () => {
  it.each([
    ['пары прежнего детектора', PREVIOUS],
    ['пары прежнего формата без детектора', UNKNOWN_DETECTOR],
  ])(
    '%s: прежний вид сразу с признаком пересчёта, сохранение без отказа; пересчёт фоном — новые пары, прежние убраны, журнал тот же; повтор пакета — batchStale',
    async (_name, detector) => {
      let failSecond = false;
      const { fs } = interceptFs(realStorageFs, (call) => {
        if (failSecond && call.op === 'rename' && call.to?.endsWith('Б.pdf') === true) {
          throw fsError('EIO');
        }
      });
      const { root, restart, straight, journal, firstOld } = await yesterday(detector, { fs });

      const again = await restart({ imageWorker: inlineImageWorker(), fs });
      // Сразу после открытия: прежний вид без «ждёт», откат на месте, пересчёт ждёт.
      expect(marksOf(again)).toEqual([
        { status: 'straightened', reason: null, version: 1, detector, recalc: 'pending' },
        { status: 'kept', reason: null, version: 1, detector, recalc: 'pending' },
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
      expect((await streamsOf(join(folder, 'А.pdf')))[0]?.equals(firstOld)).toBe(true);

      // Пересчёт фоном: пары нового детектора записаны, прежние убраны; статусы те же.
      await expect
        .poll(() => jpegsIn(straight), { timeout: 40_000, interval: 100 })
        .toEqual([straightJpegOf(F(1), 1, NEXT), straightJpegOf(F(2), 1, NEXT)]);
      await untilStraightened(() => again.snapshot());
      await expect
        .poll(() => marksOf(again), { timeout: 10_000, interval: 50 })
        .toEqual([
          { status: 'straightened', reason: null, version: 1, detector: NEXT, recalc: null },
          { status: 'kept', reason: null, version: 1, detector: NEXT, recalc: null },
        ]);
      const record = JSON.parse(
        await readFile(join(straight, straightRecordOf(F(1), 1, NEXT)), 'utf8'),
      ) as StraightRecord;
      expect(record).toMatchObject({
        v: 1,
        detector: NEXT,
        file: { name: straightJpegOf(F(1), 1, NEXT) },
      });
      expect(await journalOnDisk(root)).toEqual(journal);

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
          await readFile(join(straight, straightJpegOf(F(1), 1, NEXT))),
        ),
      ).toBe(true);
      await again.settleDerived();
    },
    120_000,
  );

  it('новый детектор ставит странице «ровная»: пара прежнего детектора убрана, статус по вердикту; остальные пересчитаны; журнал тот же', async () => {
    const { root, restart, straight, journal } = await yesterday(PREVIOUS);
    const firstBytes = (await readFile(join(layoutOf(root).pagesDir, `${F(1)}.jpg`))).byteLength;
    const real = inlineImageWorker();
    // Первая страница новому детектору «ровная», остальные — как есть.
    const worker: ImageWorker = {
      measure: (bytes, limit, options) =>
        bytes.byteLength === firstBytes
          ? Promise.resolve(LEVEL_MEASURE)
          : real.measure(bytes, limit, options),
      straighten: (bytes, profile, job) => real.straighten(bytes, profile, job),
    };

    // Измерение «ровно» мгновенное: к первому снимку пара первой страницы может быть уже снята —
    // сразу после открытия проверяется только конечное состояние.
    const again = await restart({ imageWorker: worker });

    await expect
      .poll(() => jpegsIn(straight), { timeout: 40_000, interval: 100 })
      .toEqual([straightJpegOf(F(2), 1, NEXT)]);
    await untilStraightened(() => again.snapshot());
    await expect
      .poll(() => marksOf(again), { timeout: 10_000, interval: 50 })
      .toEqual([
        { status: 'level', reason: null, version: null, detector: null, recalc: null },
        { status: 'kept', reason: null, version: 1, detector: NEXT, recalc: null },
      ]);
    expect(await journalOnDisk(root)).toEqual(journal);
    await again.settleDerived();
  }, 120_000);

  it('пакет под пересчётом: сохранение, пока коррекция держится воротами, — PDF из прежних байтов; затем новая пара на месте, прежняя убрана', async () => {
    const { root, restart, straight, firstOld } = await yesterday(PREVIOUS);
    const real = inlineImageWorker();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker: ImageWorker = {
      measure: (bytes, limit, options) => real.measure(bytes, limit, options),
      straighten: async (bytes, profile, job) => {
        await gate;
        return real.straighten(bytes, profile, job);
      },
    };

    const again = await restart({ imageWorker: worker });
    // Измерение прошло, коррекция стоит у ворот: пакет берёт прежние пары.
    await expect
      .poll(() => again.snapshot().straightenProgress?.running ?? null, { timeout: 20_000 })
      .not.toBeNull();
    const folder = join(root, 'выход');
    await mkdir(folder, { recursive: true });
    const saved = await again.saveDocuments(folder, {
      mode: 'single',
      names: ['Всё'],
      retry: false,
    });
    expect(saved).toMatchObject({ ok: true, value: { failed: [] } });
    expect((await streamsOf(join(folder, 'Всё.pdf')))[0]?.equals(firstOld)).toBe(true);

    release();
    await expect
      .poll(() => jpegsIn(straight), { timeout: 40_000, interval: 100 })
      .toEqual([straightJpegOf(F(1), 1, NEXT), straightJpegOf(F(2), 1, NEXT)]);
    await untilStraightened(() => again.snapshot());
    await again.settleDerived();
  }, 120_000);
});
