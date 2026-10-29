import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_EDITS, pageImageViewOf, type StraightenStatus } from '../../src/shared';
import type { ScanJobLimits } from '../../src/core/escl/scan-job';
import { inlineImageWorker } from '../../src/core/image/image-worker';
import type { PassService, PassServiceOptions } from '../../src/core/scan/pass-service';
import { layoutOf } from '../../src/core/storage/layout';
import { pdfImageStreams } from '../support/fixtures';
import { stubWorker } from '../support/image-worker';
import { connectService, saveSingle, scanned } from '../support/pass-service';
import { unwrap } from '../support/result';
import { journalOnDisk } from '../support/session-store';
import { until, untilScored } from '../support/until';

// Выравнивание перекоса на настоящей цепочке (план M6, U5, U12; R6, R11, KTD-4, KTD-8, KTD-9,
// KTD-12): эмулятор с настоящими косыми сканами в лотке → служба с прямым исполнителем → оценки
// и выправленные файлы как производное (`derived/<id>/skew`, `straight`) по ходу прохода →
// статусы в снимке → PDF из снимка. Измерение не задерживает приём страниц, «Остановить»
// посреди измерения не пересоздаёт каталог производного.

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

const F = (index: number): string => `p01-s01-${String(index).padStart(4, '0')}`;
const B = (index: number): string => `p02-s01-${String(index).padStart(4, '0')}`;

const skewDirOf = (root: string, sessionId: string): string =>
  join(layoutOf(root).derivedDir, sessionId, 'skew');

async function outcomesIn(dir: string): Promise<Record<string, string>> {
  const names = (await readdir(dir).catch(() => [])).sort();
  const entries = await Promise.all(
    names.map(async (name) => {
      const record = JSON.parse(await readFile(join(dir, name), 'utf8')) as { outcome: string };
      return [name.replace(/\.json$/, ''), record.outcome] as const;
    }),
  );
  return Object.fromEntries(entries);
}

const straightFiles = async (dir: string): Promise<string[]> =>
  (await readdir(dir).catch(() => [])).filter((name) => !name.endsWith('.tmp')).sort();

const statusesOf = (service: PassService): Record<string, StraightenStatus> =>
  Object.fromEntries(
    (service.snapshot().assembly?.order ?? []).map((page) => [page.key, page.straighten.status]),
  );

describe('выравнивание на эмуляторе: измерение по ходу прохода (M6, U5)', () => {
  it('косые листы в лотке получают «выправлять», фото — «не померить», скрытый пустой оборот не измеряется', async () => {
    const { root, service, restart } = await connectService(
      {
        trays: [
          ['fan-text-gray-300', 'photo-gray-300'],
          ['blank-gray-300', 'fan-table-gray-300'],
        ],
      },
      OPTIONS,
      { imageWorker: inlineImageWorker() },
    );
    await scanned(service, 2, 2);
    await untilScored(() => service.snapshot());
    const sessionId = service.snapshot().session?.id ?? '';
    const dir = skewDirOf(root, sessionId);

    await expect
      .poll(() => outcomesIn(dir), { timeout: 20_000, interval: 50 })
      .toEqual({
        [F(1)]: 'willStraighten',
        [F(2)]: 'unmeasurable',
        [B(2)]: 'willStraighten',
      });
    expect(service.snapshot().assembly?.blank.hidden).toBe(1);

    // U11: очередь коррекции выправила обе косые страницы — JPEG и запись той же версии, размер
    // в записи совпадает с файлом; фото и пустой оборот файлов не получили.
    const straight = join(layoutOf(root).derivedDir, sessionId, 'straight');
    await expect
      .poll(() => straightFiles(straight), { timeout: 20_000, interval: 50 })
      .toEqual([`${F(1)}.v1.jpg`, `${F(1)}.v1.json`, `${B(2)}.v1.jpg`, `${B(2)}.v1.json`]);
    const record = JSON.parse(await readFile(join(straight, `${F(1)}.v1.json`), 'utf8')) as {
      file: { bytes: number };
    };
    expect((await stat(join(straight, `${F(1)}.v1.jpg`))).size).toBe(record.file.bytes);

    // U12: статусы в снимке — по исходам и файлам; скрытый пустой оборот без статуса; в PDF
    // выправленные страницы идут из производного, фото — байт в байт (KTD-8).
    await until(() => service.snapshot().assembly?.straighten.pending === 0);
    const statuses = {
      [F(1)]: 'straightened',
      [B(2)]: 'straightened',
      [F(2)]: 'unmeasurable',
      [B(1)]: null,
    };
    expect(statusesOf(service)).toEqual(statuses);
    expect(service.snapshot().assembly?.straighten).toMatchObject({
      mode: 'auto',
      straightened: 2,
      unmeasurable: 1,
      pending: 0,
      total: 3,
      reasons: { measure: 1 },
    });
    expect(service.snapshot().straightenProgress).toEqual({ queued: 0, running: null });
    const pdf = await saveSingle(service, root);
    const streams = (await pdfImageStreams(await readFile(pdf))).map((stream) =>
      Buffer.from(stream.getContents()),
    );
    // Лента: F1, B2 (оборот первого листа), F2; B1 скрыт.
    expect(streams).toHaveLength(3);
    expect(streams[0]?.equals(await readFile(join(straight, `${F(1)}.v1.jpg`)))).toBe(true);
    expect(streams[1]?.equals(await readFile(join(straight, `${B(2)}.v1.jpg`)))).toBe(true);
    expect(streams[2]?.equals(await readFile(join(layoutOf(root).pagesDir, `${F(2)}.jpg`)))).toBe(
      true,
    );
    const journalBefore = await journalOnDisk(root);

    // AE8: производное потеряно целиком — после перезапуска всё досчитано заново, журнал цел.
    await rm(layoutOf(root).derivedDir, { recursive: true, force: true });
    const again = await restart({ imageWorker: inlineImageWorker() });
    await expect
      .poll(() => straightFiles(straight), { timeout: 20_000, interval: 50 })
      .toHaveLength(4);
    expect(await outcomesIn(dir)).toEqual({
      [F(1)]: 'willStraighten',
      [F(2)]: 'unmeasurable',
      [B(2)]: 'willStraighten',
    });
    await until(() => again.snapshot().assembly?.straighten.pending === 0);
    expect(statusesOf(again)).toEqual(statuses);
    expect(await journalOnDisk(root)).toEqual(journalBefore);
    await again.settleDerived();
  }, 60_000);

  it('AE16: «Новое сканирование» посреди измерений и коррекции — всё отменено, производное удалено и не пересоздано', async () => {
    const { root, service } = await connectService(
      { trays: [['fan-text-gray-300', 'fan-table-gray-300', 'fan-text-gray-300']] },
      OPTIONS,
      { imageWorker: inlineImageWorker() },
    );
    await scanned(service, 3);
    const derived = layoutOf(root).derivedDir;
    // Хоть что-то уже в работе: первый вердикт пришёл, очередь коррекции запущена.
    await expect
      .poll(() => readdir(derived).catch(() => []), { timeout: 20_000, interval: 20 })
      .toHaveLength(1);

    expect(await service.closeSession()).toEqual({ ok: true, value: undefined });

    expect(service.snapshot().session).toBeNull();
    expect(await readdir(derived).catch(() => [])).toEqual([]);
    await service.settleDerived();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await readdir(derived).catch(() => [])).toEqual([]);
  }, 30_000);

  it('измерение не задерживает приём страниц: проход завершён, пока исполнитель ещё держит первую', async () => {
    const gated = stubWorker({ gated: true });
    const { service } = await connectService({ trays: [[1, 2, 3]] }, OPTIONS, {
      imageWorker: gated.worker,
    });

    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 3 });
    expect(gated.started()).toBeGreaterThanOrEqual(1);

    gated.release();
    await service.settleDerived();
  });

  it('«Остановить» посреди измерения первого прохода: сессии нет, производное не пересоздано', async () => {
    const gated = stubWorker({ gated: true });
    const { root, service } = await connectService(
      { trays: [[1, 2, 3, 4, 5, 6]], pageDelayMs: 150 },
      OPTIONS,
      { imageWorker: gated.worker },
    );

    const pass = service.startPass(null);
    await until(() => gated.started() >= 1);
    expect(await service.stopPass()).toEqual({ ok: true, value: undefined });
    expect(unwrap(await pass)).toMatchObject({ end: 'stopped', pages: 0 });

    gated.release();
    await service.settleDerived();
    expect(service.snapshot().session).toBeNull();
    expect(await readdir(layoutOf(root).derivedDir).catch(() => [])).toEqual([]);
  });

  it('AE3: «Оставить оригинал» — статус kept, вид картинки и байты PDF — исходник; «Вернуть» возвращает выправленный', async () => {
    const { root, service } = await connectService(
      { trays: [['fan-text-gray-300', 'photo-gray-300']] },
      OPTIONS,
      { imageWorker: inlineImageWorker() },
    );
    await scanned(service, 2);
    await expect
      .poll(() => service.snapshot().assembly?.straighten.pending, {
        timeout: 20_000,
        interval: 50,
      })
      .toBe(0);
    const page = service.snapshot().assembly?.order[0];
    expect(page).toMatchObject({ key: F(1), straighten: { status: 'straightened', version: 1 } });
    expect(pageImageViewOf(page ?? { key: F(1) }, 'thumb')).toEqual({
      view: 'straight-thumb',
      key: F(1),
      version: 1,
    });

    unwrap(await service.setEdits({ ...EMPTY_EDITS, keepOriginal: [F(1)] }, {}));
    const kept = service.snapshot().assembly?.order[0];
    expect(kept?.straighten).toEqual({ status: 'kept', reason: null, version: 1 });
    expect(pageImageViewOf(kept ?? { key: F(1) }, 'page').view).toBe('page');
    expect(service.snapshot().assembly?.hasEdits).toBe(true);

    const pdf = await saveSingle(service, root);
    const streams = (await pdfImageStreams(await readFile(pdf))).map((stream) =>
      Buffer.from(stream.getContents()),
    );
    const pagesDir = layoutOf(root).pagesDir;
    expect(streams[0]?.equals(await readFile(join(pagesDir, `${F(1)}.jpg`)))).toBe(true);
    expect(streams[1]?.equals(await readFile(join(pagesDir, `${F(2)}.jpg`)))).toBe(true);

    unwrap(await service.setEdits(EMPTY_EDITS, {}));
    expect(service.snapshot().assembly?.order[0]?.straighten.status).toBe('straightened');
    await service.settleDerived();
  }, 40_000);

  it('AE6: режим «не выравнивать» — статусов нет, оценок в derived/ нет, PDF байт в байт как до M6', async () => {
    const { root, service } = await connectService(
      { trays: [['fan-text-gray-300', 'fan-table-gray-300']] },
      OPTIONS,
      { imageWorker: inlineImageWorker() },
    );
    unwrap(await service.setStraightenMode('off'));
    await scanned(service, 2);
    expect(service.snapshot().session?.straighten).toBe('off');

    await untilScored(() => service.snapshot());
    expect(statusesOf(service)).toEqual({ [F(1)]: null, [F(2)]: null });
    expect(service.snapshot().straightenProgress).toBeNull();
    const pdf = await saveSingle(service, root);
    const streams = (await pdfImageStreams(await readFile(pdf))).map((stream) =>
      Buffer.from(stream.getContents()),
    );
    const pagesDir = layoutOf(root).pagesDir;
    expect(streams[0]?.equals(await readFile(join(pagesDir, `${F(1)}.jpg`)))).toBe(true);
    expect(streams[1]?.equals(await readFile(join(pagesDir, `${F(2)}.jpg`)))).toBe(true);
    const sessionId = service.snapshot().session?.id ?? '';
    expect(await readdir(join(layoutOf(root).derivedDir, sessionId)).catch(() => [])).toEqual([]);
  });
});
