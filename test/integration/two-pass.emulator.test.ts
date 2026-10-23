import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { EMPTY_EDITS } from '@shared';
import { probeScanner, type ConnectedScanner } from '../../src/core/escl/connect';
import type { ScanJobLimits } from '../../src/core/escl/scan-job';
import {
  openPassService,
  type PassService,
  type PassServiceOptions,
} from '../../src/core/scan/pass-service';
import { layoutOf } from '../../src/core/storage/layout';
import type { Snapshot } from '../../src/shared';
import type { Scenario } from '../emulator/scenarios';
import { startTestEmulator } from '../support/emulator';
import { pageFixture } from '../support/fixtures';
import { makeTempDataRoot } from '../support/temp-data-root';
import { unwrap } from '../support/result';
import { until, untilScored } from '../support/until';

// Двухпроходный сценарий на настоящей цепочке (план M2, U3–U4): эмулятор с лотками по заданиям →
// клиент → хранилище → сборка в снимке. Правило пар проверяется побайтово: какая фикстура легла
// на какое место набора. Разворот стопки эмулирует порядок лотков: лицевые 1,2,3 — фикстуры
// 1..3; обороты подаются обратным порядком — 6,5,4 (первым идёт оборот последнего листа).

const FRONTS = [1, 2, 3];
const BACKS = [6, 5, 4];

const FAST: Partial<ScanJobLimits> = {
  retryDelayMs: 5,
  busyCeilingMs: 200,
  notReadyCeilingMs: 2000,
  pageIdleTimeoutMs: 300,
  pageDeadlineMs: 3000,
  deleteDeadlineMs: 300,
};

interface Harness {
  readonly root: string;
  readonly service: PassService;
  readonly snapshots: Snapshot[];
  readonly restart: () => Promise<Harness>;
}

async function open(root: string, connected: ConnectedScanner): Promise<Harness> {
  const snapshots: Snapshot[] = [];
  const service: PassService = await openPassService(root, {
    jobLimits: FAST,
    minFreeBytes: 1,
    retry: { ceilingMs: 50 },
    onChange: () => {
      snapshots.push(service.snapshot());
    },
  } satisfies PassServiceOptions);
  await service.useScanner(connected);
  return { root, service, snapshots, restart: () => open(root, connected) };
}

async function setup(scenario: Partial<Scenario> = {}) {
  const emulator = await startTestEmulator({
    scenario: { trays: [FRONTS, BACKS], ...scenario },
  });
  const probed = await probeScanner({ ...emulator, fingerprint: null });
  if (!probed.ok) {
    throw new Error(`эмулятор не подключился: ${probed.error.code}`);
  }
  const harness = await open(await makeTempDataRoot(), probed.value);
  return { emulator, ...harness };
}

/** Побайтовая сверка собранного порядка с ожидаемыми фикстурами. */
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

describe('два прохода через эмулятор (M2)', () => {
  it('AE1: полный прогон — interleave правильный, оборот последнего листа пришёл первым', async () => {
    const { service, snapshots, root } = await setup();

    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 3 });
    expect(service.snapshot().assembly?.report).toMatchObject({ fronts: 3, backs: 0 });

    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 3 });

    // Счётчик второго прохода нёс «из 3» (R2).
    expect(
      snapshots.some((it) => it.pass !== null && it.pass.expected === 3 && !it.pass.resumed),
    ).toBe(true);

    const snapshot = service.snapshot();
    expect(snapshot.assembly?.report).toMatchObject({ mode: 'pairs', backs: 3, mismatch: false });
    expect(snapshot.assembly?.order.map((page) => `${page.sheet ?? '?'}${page.side}`)).toEqual([
      '1front',
      '1back',
      '2front',
      '2back',
      '3front',
      '3back',
    ]);
    // Лист 1 получает оборот-фикстуру 4: обороты пришли обратным порядком (KTD-4, техбаза §5).
    await expectAssembledFixtures(root, snapshot, [1, 4, 2, 5, 3, 6]);
  });

  it('AE1/AE8: сценарий целиком — два прохода, тумблер 180°, сохранение в PDF', async () => {
    const { service, root } = await setup();

    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 3 });
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 3 });
    unwrap(await service.setEdits(EMPTY_EDITS, { 2: true }));
    await untilScored(() => service.snapshot());

    const outDir = join(root, 'выход');
    await mkdir(outDir, { recursive: true });
    expect(
      unwrap(
        await service.saveDocuments(outDir, { mode: 'single', names: ['скан'], retry: false }),
      ),
    ).toEqual({ folder: outDir, written: [{ index: 0, fileName: 'скан.pdf' }], failed: [] });

    // PDF несёт собранный порядок; /Rotate 180 — только на оборотах (AE8).
    const document = await PDFDocument.load(await readFile(join(outDir, 'скан.pdf')));
    expect(document.getPageCount()).toBe(6);
    expect(document.getPages().map((page) => page.getRotation().angle)).toEqual([
      0, 180, 0, 180, 0, 180,
    ]);
    expect(service.snapshot().session?.saved).toBe(true);

    // Исходники страниц не изменились: фикстура листа 1 лежит байт в байт (AE8).
    const snapshot = service.snapshot();
    await expectAssembledFixtures(root, snapshot, [1, 4, 2, 5, 3, 6]);
  });

  it('R6/AE7: перезапуск между проходами — вторая служба доводит второй проход', async () => {
    const { service, restart, root } = await setup();
    unwrap(await service.startPass(null));

    const second = await restart();
    const resumedSnapshot = second.service.snapshot();
    // Сессия в «flip»-форме: единственный уцелевший проход — лицевой, завершён, отказа нет.
    expect(resumedSnapshot.session?.passes.map((pass) => pass.state)).toEqual(['completed']);
    expect(resumedSnapshot.session?.backsDeclined).toBe(false);

    expect(unwrap(await second.service.startPass(null))).toMatchObject({
      end: 'completed',
      pages: 3,
    });
    await expectAssembledFixtures(root, second.service.snapshot(), [1, 4, 2, 5, 3, 6]);
  });

  it('AE3: недостающий лист второго прохода — раздельные наборы: лица, затем обороты обратным порядком (M3.6)', async () => {
    const { service, root } = await setup({ trays: [FRONTS, [6, 5]] });
    unwrap(await service.startPass(null));
    unwrap(await service.startPass(null));

    const snapshot = service.snapshot();
    expect(snapshot.assembly?.report).toMatchObject({
      mode: 'sets',
      groups: { fronts: 3, backs: 2, divider: 3 },
      fronts: 3,
      backs: 2,
      mismatch: true,
    });
    // Обороты пришли от последнего листа (6, затем 5) — в наборе оборотов показаны 5, 6; первый
    // проход цел; пар до «Собрать документ» нет.
    await expectAssembledFixtures(root, snapshot, [1, 2, 3, 5, 6]);
  });

  it('AE9: оборотов больше, чем лиц, — счётчик переваливает, лишний в конце и не выброшен', async () => {
    const { service, snapshots, root } = await setup({
      trays: [
        [1, 2],
        [6, 5, 4],
      ],
    });
    unwrap(await service.startPass(null));
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 3 });

    // «4 из 3» здесь — «3 из 2»: снимок с страницами сверх ожидаемого, не подрезан.
    expect(
      snapshots.some((it) => it.pass !== null && it.pass.expected === 2 && it.pass.pages === 3),
    ).toBe(true);

    // Раздельные наборы (M3.6): все три оборота в наборе оборотов, ни один не выброшен.
    const snapshot = service.snapshot();
    expect(snapshot.assembly?.report).toMatchObject({
      mode: 'sets',
      groups: { fronts: 2, backs: 3, divider: 2 },
      fronts: 2,
      backs: 3,
      mismatch: true,
    });
    const last = snapshot.assembly?.order.at(-1);
    expect(last).toMatchObject({ key: 'p02-s01-0001', side: 'back', sheet: 3 });
    await expectAssembledFixtures(root, snapshot, [1, 2, 4, 5, 6]);
  });

  it('AE4: обрыв второго прохода — прерван, страницы целы; досканирование доводит сборку', async () => {
    const { service, emulator, root } = await setup({
      fault: { sheet: 5, kind: 'gone' },
    });
    unwrap(await service.startPass(null));
    const interrupted = await service.startPass(null);
    expect(interrupted).toMatchObject({
      ok: true,
      value: { end: 'interrupted', pages: 1, error: { code: 'scanFeedFailed' } },
    });

    let snapshot = service.snapshot();
    expect(snapshot.session?.passes.map((pass) => pass.state)).toEqual([
      'completed',
      'interrupted',
    ]);
    expect(snapshot.canResume).toBe(true);
    expect(snapshot.canAccept).toBe(true);
    // До приёмки — раздельные наборы (M3.6, R4): один оборот в группе оборотов.
    expect(snapshot.assembly?.report).toMatchObject({
      mode: 'sets',
      groups: { fronts: 3, backs: 1, divider: 3 },
    });

    // «Досканировать остаток»: бумага из замятия вынута, остаток стопки — обратно в лоток.
    emulator.clearJam();
    emulator.reloadTray([5, 4]);
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 2 });

    snapshot = service.snapshot();
    expect(snapshot.assembly?.report).toMatchObject({ mode: 'pairs', backs: 3, mismatch: false });
    await expectAssembledFixtures(root, snapshot, [1, 4, 2, 5, 3, 6]);
  });

  it('AE4: «Оставить как есть» после обрыва — сборка по фактическим парам, состояние в отчёте', async () => {
    const { service } = await setup({ fault: { sheet: 5, kind: 'gone' } });
    unwrap(await service.startPass(null));
    await service.startPass(null);

    expect(await service.acceptPass()).toEqual({ ok: true, value: undefined });

    expect(service.snapshot().assembly?.report).toMatchObject({
      mode: 'sets',
      fronts: 3,
      backs: 1,
      backsState: 'accepted',
      mismatch: true,
    });
  });

  it('AE6: «Остановить» на первом сегменте оборотов возвращает к «flip», проход №3 — оборотный', async () => {
    const { service, emulator, snapshots, root } = await setup({ pageDelayMs: 120 });
    unwrap(await service.startPass(null));

    // Второй проход останавливается после первой страницы.
    const backs = service.startPass(null);
    await until(() => service.snapshot().pass?.pages === 1);
    expect(await service.stopPass()).toEqual({ ok: true, value: undefined });
    expect(unwrap(await backs)).toMatchObject({ end: 'stopped' });

    // Страницы оборотов отброшены, лицевой цел; сессия снова в «flip»-форме.
    const stopped = service.snapshot();
    expect(stopped.session?.passes.map((pass) => [pass.number, pass.state])).toEqual([
      [1, 'completed'],
    ]);
    expect(stopped.assembly?.report).toMatchObject({ fronts: 3, backs: 0, mismatch: false });

    // Повторный запуск: проход получает номер 3 и ведёт себя как оборотный (KTD-4).
    emulator.reloadTray(BACKS);
    const before = snapshots.length;
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 3 });
    expect(
      snapshots
        .slice(before)
        .some((it) => it.pass !== null && it.pass.expected === 3 && !it.pass.resumed),
    ).toBe(true);

    expect(service.snapshot().session?.passes.map((pass) => pass.number)).toEqual([1, 3]);
    expect(await service.setEdits(EMPTY_EDITS, { 3: true })).toEqual({
      ok: true,
      value: { seq: service.snapshot().seq },
    });
    expect(service.snapshot().session?.passes.map((pass) => [pass.number, pass.rotate180])).toEqual(
      [
        [1, false],
        [3, true],
      ],
    );
    await expectAssembledFixtures(root, service.snapshot(), [1, 4, 2, 5, 3, 6]);
  });

  it('AE5: «обороты не нужны» переживает перезапуск — сессия не возвращается к развороту', async () => {
    const { service, restart } = await setup();
    unwrap(await service.startPass(null));
    unwrap(await service.declineBacks());

    const second = await restart();
    expect(second.service.snapshot().session?.backsDeclined).toBe(true);
    expect(second.service.snapshot().assembly?.report).toMatchObject({
      backsDeclined: true,
      mismatch: false,
    });
    expect(await second.service.startPass(null)).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'backsDeclined' } },
    });
  });
});
