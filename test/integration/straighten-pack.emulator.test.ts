import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_EDITS, type AssembledPage } from '../../src/shared';
import type { ScanJobLimits } from '../../src/core/escl/scan-job';
import { inlineImageWorker } from '../../src/core/image/image-worker';
import type { PassService, PassServiceOptions } from '../../src/core/scan/pass-service';
import { layoutOf } from '../../src/core/storage/layout';
import { SCENARIOS } from '../emulator/scenarios';
import { pdfImageStreams } from '../support/fixtures';
import { keyOf } from '../support/assembly';
import { analyzeGrid } from '../support/grid-analysis';
import { connectService, saveSingle, scanned } from '../support/pass-service';
import { unwrap } from '../support/result';
import { sessionIdOf, skewDirOf, statusesOf, straightDirOf } from '../support/straighten';
import { untilStraightened } from '../support/until';

// Пачка M6 на эмуляторе (план M6, U9; AE1, AE2, AE7, AE11, AE12, AE17): сценарии `fan-pack` и
// `fan-grid` — настоящие сканы с остановкой подачи, ровная синтетическая страница, фото,
// ловушка детектора, пустой оборот; настоящий исполнитель в потоке теста. Проверяется то, что
// увидит пользователь: статусы ленты, файлы производного и байты в PDF — выправленные из
// `straight/`, остальные байт в байт из исходника (KTD-8). Подсказки устройства у детектора нет
// (AE7): путь один для любого сканера — эмулятор здесь и есть «другое устройство».

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

const F = (index: number): string => keyOf(1, index);
const B = (index: number): string => keyOf(2, index);

const shownOrder = (service: PassService): AssembledPage[] =>
  (service.snapshot().assembly?.order ?? []).filter((page) => page.blank !== 'hidden');

/** Байты страницы, какими они уходят в файл: выправленной — производное, остальным — исходник. */
async function fileBytesOf(root: string, sessionId: string, page: AssembledPage): Promise<Buffer> {
  const { status, version } = page.straighten;
  return status === 'straightened'
    ? readFile(join(straightDirOf(root, sessionId), `${page.key}.v${String(version)}.jpg`))
    : readFile(join(layoutOf(root).pagesDir, `${page.key}.jpg`));
}

/** PDF одним файлом: поток каждой показанной страницы равен её байтам по статусу (KTD-8). */
async function expectPdfBySnapshot(
  service: PassService,
  root: string,
  name: string,
): Promise<void> {
  const sessionId = sessionIdOf(service);
  const shown = shownOrder(service);
  const pdf = await saveSingle(service, root, name);
  const streams = await pdfImageStreams(await readFile(pdf));
  expect(streams).toHaveLength(shown.length);
  for (const [index, page] of shown.entries()) {
    const expected = await fileBytesOf(root, sessionId, page);
    const actual = Buffer.from(streams[index]?.getContents() ?? new Uint8Array());
    expect(
      actual.equals(expected),
      `${name}: ${page.key} (${String(page.straighten.status)})`,
    ).toBe(true);
  }
}

describe('пачка M6 на эмуляторе (U9)', () => {
  it('fan-pack: статусы по содержимому; ровная без файла; скрытый пустой не измерен, после «не пустая» — измерен; откат ядро принимает по ключу; PDF по статусам', async () => {
    const { root, service } = await connectService(SCENARIOS['fan-pack'], OPTIONS, REAL);
    await scanned(service, 5, 5);
    await untilStraightened(() => service.snapshot());
    const sessionId = sessionIdOf(service);

    // Лица: косой текст, ровная, фото, две колонки (ловушка — любой честный исход), таблица;
    // обороты поданы обратным порядком: B1 — оборот листа 5 (бедный лист), B2 — пустой скан.
    const statuses = statusesOf(service);
    expect(statuses).toMatchObject({
      [F(1)]: 'straightened',
      [F(2)]: 'level',
      [F(3)]: 'unmeasurable',
      [F(5)]: 'straightened',
      [B(1)]: 'straightened',
      [B(2)]: null,
      [B(3)]: 'straightened',
      [B(4)]: 'unmeasurable',
      [B(5)]: 'straightened',
    });
    expect(['straightened', 'unmeasurable']).toContain(statuses[F(4)]);
    const trapStraight = statuses[F(4)] === 'straightened' ? 1 : 0;
    expect(service.snapshot().assembly?.straighten).toMatchObject({
      mode: 'auto',
      straightened: 5 + trapStraight,
      unmeasurable: 3 - trapStraight,
      level: 1,
      pending: 0,
      deferred: 0,
      total: 9,
    });
    expect(service.snapshot().assembly?.blank.hidden).toBe(1);

    // AE11: ровная — статус без версии, файла в straight/ нет.
    const straightFiles = await readdir(straightDirOf(root, sessionId));
    expect(straightFiles).toContain(`${F(1)}.v1.jpg`);
    expect(straightFiles).not.toContain(`${F(2)}.v1.jpg`);
    expect(
      service.snapshot().assembly?.order.find((page) => page.key === F(2))?.straighten,
    ).toEqual({ status: 'level', reason: null, version: null });
    // AE12: скрытый пустой оборот не измерен — записи оценки нет.
    const skewDir = skewDirOf(root, sessionId);
    expect(await readdir(skewDir)).not.toContain(`${B(2)}.json`);
    await expectPdfBySnapshot(service, root, 'Пачка');

    // AE12: «Это не пустая страница» — оборот измеряется; пустой лист — мерить не по чему.
    unwrap(await service.setEdits({ ...EMPTY_EDITS, notBlank: [B(2)] }, {}));
    await untilStraightened(() => service.snapshot());
    expect(await readdir(skewDir)).toContain(`${B(2)}.json`);
    expect(['unmeasurable', 'level']).toContain(statusesOf(service)[B(2)]);
    expect(service.snapshot().assembly?.straighten.total).toBe(10);

    // AE17, сторона ядра: ключ отката принимается у любой живой страницы, статус меняет только
    // у выправленной; отбор подходящих страниц в выделении — renderer (jsdom-тесты).
    unwrap(
      await service.setEdits(
        { ...EMPTY_EDITS, notBlank: [B(2)], keepOriginal: [F(1), F(2), F(3)] },
        {},
      ),
    );
    expect(service.snapshot().session?.edits.keepOriginal).toEqual([F(1), F(2), F(3)]);
    expect(statusesOf(service)).toMatchObject({
      [F(1)]: 'kept',
      [F(2)]: 'level',
      [F(3)]: 'unmeasurable',
    });
    await expectPdfBySnapshot(service, root, 'После отката');
    await service.settleDerived();
  }, 120_000);

  it('AE1: сетки после коррекции — остаточный веер ≤ 0,5 мм на полном разрешении; в PDF — выправленные байты', async () => {
    const { root, service } = await connectService(SCENARIOS['fan-grid'], OPTIONS, REAL);
    await scanned(service, 3);
    await untilStraightened(() => service.snapshot());
    const sessionId = sessionIdOf(service);

    const lines: string[] = [];
    for (const page of shownOrder(service)) {
      expect(page.straighten.status, page.key).toBe('straightened');
      const before = await analyzeGrid(
        await readFile(join(layoutOf(root).pagesDir, `${page.key}.jpg`)),
        300,
      );
      const after = await analyzeGrid(await fileBytesOf(root, sessionId, page), 300);
      lines.push(
        `${page.key}: веер ${before.fanMm.toFixed(2)} → ${after.fanMm.toFixed(2)} мм (горизонталей ${String(after.horizontals.length)})`,
      );
      expect(after.fanMm, page.key).toBeLessThanOrEqual(0.5);
      expect(after.fanMm, page.key).toBeLessThan(before.fanMm);
    }
    console.info(`[U9 fan-grid]\n${lines.join('\n')}`);
    await expectPdfBySnapshot(service, root, 'Сетки');
    await service.settleDerived();
  }, 120_000);
});
