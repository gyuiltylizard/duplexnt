import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScanJobLimits } from '../../src/core/escl/scan-job';
import { inlineImageWorker } from '../../src/core/image/image-worker';
import type { PassServiceOptions } from '../../src/core/scan/pass-service';
import { layoutOf } from '../../src/core/storage/layout';
import { stubWorker } from '../support/image-worker';
import { connectService, scanned } from '../support/pass-service';
import { unwrap } from '../support/result';
import { until, untilScored } from '../support/until';

// Выравнивание перекоса на настоящей цепочке (план M6, U5; R6, R11, KTD-4, KTD-12): эмулятор с
// настоящими косыми сканами в лотке → служба с прямым исполнителем → оценки как производное
// (`derived/<id>/skew`) по ходу прохода. Измерение не задерживает приём страниц, «Остановить»
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

describe('выравнивание на эмуляторе: измерение по ходу прохода (M6, U5)', () => {
  it('косые листы в лотке получают «выправлять», фото — «не померить», скрытый пустой оборот не измеряется', async () => {
    const { root, service } = await connectService(
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
  }, 15_000);

  it('измерение не задерживает приём страниц: проход завершён, пока исполнитель ещё держит первую', async () => {
    const gated = stubWorker({ gated: true });
    const { service } = await connectService({ trays: [[1, 2, 3]] }, OPTIONS, {
      imageWorker: gated.worker,
    });

    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 3 });
    expect(gated.started()).toBeGreaterThanOrEqual(1);

    gated.release();
    await service.shutdown();
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
    await service.shutdown();
    expect(service.snapshot().session).toBeNull();
    expect(await readdir(layoutOf(root).derivedDir).catch(() => [])).toEqual([]);
  });
});
