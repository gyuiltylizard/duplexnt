import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_EDITS, type SessionEdits, type Snapshot } from '@shared';
import { probeScanner, type ConnectedScanner } from '../../src/core/escl/connect';
import type { ScanJobLimits } from '../../src/core/escl/scan-job';
import {
  openPassService,
  type PassService,
  type PassServiceOptions,
} from '../../src/core/scan/pass-service';
import { SCENARIOS, type Scenario } from '../emulator/scenarios';
import { startTestEmulator } from '../support/emulator';
import { pageFixtureNumberOf, pdfImageStreams } from '../support/fixtures';
import { journalOnDisk, rolesOf } from '../support/session-store';
import { makeTempDataRoot } from '../support/temp-data-root';
import { unwrap } from '../support/result';

// «Добавить» — полный путь на настоящей цепочке (план M3.5, U8): эмулятор с лотками по заданиям
// → служба с намерением → журнал v4 с ролью и якорем → сборка по якорям → правки поверх →
// перезапуск службы → PDF. Приёмочные примеры плана: AE1–AE3, AE5, AE7, AE8, AE11. Сценарии
// эмулятора — те же, что у `npm run emulator` и CDP-смоука.

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

// Пары из трёх листов: лица 1–3, обороты обратным порядком — оборот третьего пришёл первым.
const F1 = 'p01-s01-0001';
const F2 = 'p01-s01-0002';
const F3 = 'p01-s01-0003';
const B3 = 'p02-s01-0001';
const B2 = 'p02-s01-0002';
const B1 = 'p02-s01-0003';
const A1 = 'p03-s01-0001';

async function connect(scenario: Partial<Scenario>) {
  const emulator = await startTestEmulator({ scenario });
  const connected: ConnectedScanner = unwrap(
    await probeScanner({ ...emulator, fingerprint: null }),
  );
  const root = await makeTempDataRoot();
  const service = await openPassService(root, OPTIONS);
  await service.useScanner(connected);
  return { emulator, connected, root, service };
}

const keysOf = (snapshot: Snapshot): string[] =>
  snapshot.assembly?.order.map((page) => page.key) ?? [];

const setsOf = (snapshot: Snapshot): (number | null)[] =>
  snapshot.assembly?.order.map((page) => page.addedSet) ?? [];

/** Какая фикстурная страница лежит на каждой странице PDF — порядок в файле сверяется точно. */
async function pdfFixtures(path: string): Promise<number[]> {
  const streams = await pdfImageStreams(await readFile(path));
  return streams.map((stream) => pageFixtureNumberOf(stream.contents));
}

/** Вступительные проходы по порядку: каждый завершён с ожидаемым числом страниц. */
async function scanned(service: PassService, ...pages: readonly number[]): Promise<void> {
  for (const count of pages) {
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: count });
  }
}

describe('«Добавить» — полный путь через эмулятор (M3.5, U8)', () => {
  it('AE1, AE3, AE11: несовпадение → набор после текущей → перезапуск службы → ручной порядок + набор → PDF с добавленными на месте', async () => {
    // Оборотов два: лист №1 без пары; затем два добавления по одному листу (`add-twice`,
    // но с недостающим оборотом).
    const {
      connected,
      root,
      service: first,
    } = await connect({
      trays: [[1, 2, 3], [6, 5], [7], [8]],
    });
    await scanned(first, 3, 2);
    // Раздельные наборы (M3.6): лица, затем обороты обратным порядком подачи.
    expect(first.snapshot().assembly?.report).toMatchObject({
      mode: 'sets',
      fronts: 3,
      backs: 2,
      pairs: 2,
      unpairedSheets: [1],
      mismatch: true,
    });
    expect(keysOf(first.snapshot())).toEqual([F1, F2, F3, B2, B3]);

    // AE1: текущая — лицо первого листа; набор из одной страницы встаёт сразу за ним, в группе лиц.
    expect(unwrap(await first.startPass({ kind: 'added', after: F1 }))).toMatchObject({
      end: 'completed',
      pages: 1,
    });
    expect(keysOf(first.snapshot())).toEqual([F1, A1, F2, F3, B2, B3]);
    expect(setsOf(first.snapshot())).toEqual([null, 1, null, null, null, null]);
    // Отчёт пар добавление не меняет: лист №1 остаётся непарным (KTD-7 M3).
    expect(first.snapshot().assembly?.report).toMatchObject({
      unpairedSheets: [1],
      mismatch: true,
    });
    expect(first.snapshot().assembly).toMatchObject({ hasEdits: false, orderEdited: false });

    // Перезапуск: журнал v4 несёт роль и якорь — набор на месте.
    const service = await openPassService(root, OPTIONS);
    await service.useScanner(connected);
    expect(rolesOf((await journalOnDisk(root)).passes)).toEqual([
      [1, 'fronts', null],
      [2, 'backs', null],
      [3, 'added', F1],
    ]);
    expect(keysOf(service.snapshot())).toEqual([F1, A1, F2, F3, B2, B3]);

    // AE3: ручной порядок — третий лист в начало; затем добавление после лица 2.
    const manual: SessionEdits = { ...EMPTY_EDITS, order: [F3, F1, A1, F2, B2, B3] };
    unwrap(await service.setEdits(manual, false));
    expect(unwrap(await service.startPass({ kind: 'added', after: F2 }))).toMatchObject({
      end: 'completed',
      pages: 1,
    });
    // Новый ключ встал за предшественником по автопорядку (F2), расстановка не тронута,
    // плашка правок — как была (ручной порядок), набор — на месте.
    const A2 = 'p04-s01-0001';
    expect(service.snapshot().session?.edits).toEqual({
      ...manual,
      order: [F3, F1, A1, F2, A2, B2, B3],
    });
    expect(keysOf(service.snapshot())).toEqual([F3, F1, A1, F2, A2, B2, B3]);
    expect(setsOf(service.snapshot())).toEqual([null, null, 1, null, 2, null, null]);
    expect(service.snapshot().assembly).toMatchObject({ hasEdits: true, orderEdited: true });

    // AE11: PDF — страницы в порядке ленты, добавленные на своих местах.
    const folder = join(root, 'выход');
    await mkdir(folder, { recursive: true });
    const saved = unwrap(
      await service.saveDocuments(folder, { mode: 'single', names: ['Набор'], retry: false }),
    );
    expect(saved.failed).toEqual([]);
    expect(await pdfFixtures(join(folder, 'Набор.pdf'))).toEqual([3, 1, 7, 2, 8, 5, 6]);
    expect(service.snapshot().session?.saved).toBe(true);
  });

  it('AE2: «обороты не нужны» → набор в конец документа: вне отчёта, без поворота оборотов', async () => {
    const { service } = await connect(SCENARIOS['add-after-declined']);
    await scanned(service, 3);
    unwrap(await service.declineBacks());

    // «В конец документа» — якорь последней видимой страницы документа (KTD-8).
    expect(unwrap(await service.startPass({ kind: 'added', after: F3 }))).toMatchObject({
      end: 'completed',
      pages: 1,
    });
    const snapshot = service.snapshot();
    expect(keysOf(snapshot)).toEqual([F1, F2, F3, 'p02-s01-0001']);
    expect(setsOf(snapshot)).toEqual([null, null, null, 1]);
    expect(snapshot.assembly?.report).toMatchObject({
      fronts: 3,
      backs: 0,
      backsState: null,
      backsDeclined: true,
      mismatch: false,
    });
    expect(snapshot.assembly?.order.every((page) => page.angle === 0 && !page.unpaired)).toBe(true);
    expect(snapshot.session?.passes.map((pass) => pass.kind)).toEqual(['fronts', 'added']);
  });

  it('AE7: два набора с одной текущей — второй сразу за якорем; третий — за последней страницей первого', async () => {
    const { service } = await connect({
      trays: [[1, 2, 3], [6, 5, 4], [7, 8], [9], [10]],
    });
    await scanned(service, 3, 3);

    unwrap(await service.startPass({ kind: 'added', after: F2 }));
    unwrap(await service.startPass({ kind: 'added', after: F2 }));
    expect(keysOf(service.snapshot())).toEqual([
      F1,
      B1,
      F2,
      'p04-s01-0001',
      A1,
      'p03-s01-0002',
      B2,
      F3,
      B3,
    ]);
    expect(setsOf(service.snapshot())).toEqual([null, null, null, 2, 1, 1, null, null, null]);

    // Чтобы продолжить за набором, выбирают его последнюю страницу.
    unwrap(await service.startPass({ kind: 'added', after: 'p03-s01-0002' }));
    expect(keysOf(service.snapshot())).toEqual([
      F1,
      B1,
      F2,
      'p04-s01-0001',
      A1,
      'p03-s01-0002',
      'p05-s01-0001',
      B2,
      F3,
      B3,
    ]);
    expect(setsOf(service.snapshot()).filter((set) => set !== null)).toEqual([2, 1, 1, 3]);
  });

  it('AE8: пустой лоток при «Начать скан» — отказ scanNoPaper, сессия и лента прежние', async () => {
    const { root, service } = await connect(SCENARIOS['add-empty-tray']);
    await scanned(service, 3, 3);
    const before = keysOf(service.snapshot());

    expect(await service.startPass({ kind: 'added', after: F2 })).toMatchObject({
      ok: false,
      error: { code: 'scanNoPaper' },
    });

    expect((await journalOnDisk(root)).passes.map((pass) => pass.number)).toEqual([1, 2]);
    expect(keysOf(service.snapshot())).toEqual(before);
    expect(service.snapshot()).toMatchObject({ canResume: false, canAccept: false });
  });

  it('AE5: замятие на втором листе набора → плашка переживает перезапуск → досканирование в конец блока', async () => {
    const { emulator, root, service: first } = await connect(SCENARIOS['add-jam']);
    await scanned(first, 3, 3);
    expect(unwrap(await first.startPass({ kind: 'added', after: F2 }))).toMatchObject({
      end: 'interrupted',
      pages: 1,
    });

    // Перезапуск приложения: проход прерван, плашка на месте — ядро предлагает досканировать.
    const service = await openPassService(root, OPTIONS);
    expect(service.snapshot()).toMatchObject({ canResume: false, canAccept: true });
    expect(service.snapshot().session?.passes.at(-1)).toMatchObject({
      number: 3,
      kind: 'added',
      after: F2,
      state: 'interrupted',
    });
    await service.useScanner(unwrap(await probeScanner({ ...emulator, fingerprint: null })));
    expect(service.snapshot().canResume).toBe(true);
    expect(keysOf(service.snapshot())).toEqual([F1, B1, F2, A1, B2, F3, B3]);

    emulator.clearJam();
    emulator.reloadTray([8, 9]);
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 2 });
    expect(keysOf(service.snapshot())).toEqual([
      F1,
      B1,
      F2,
      A1,
      'p03-s02-0001',
      'p03-s02-0002',
      B2,
      F3,
      B3,
    ]);
    expect(setsOf(service.snapshot())).toEqual([null, null, null, 1, 1, 1, null, null, null]);
    expect(service.snapshot()).toMatchObject({ canResume: false, canAccept: false });
  });

  it('AE5: «Оставить как есть» — набор принят коротким, плашка снята', async () => {
    const { service } = await connect(SCENARIOS['add-jam']);
    await scanned(service, 3, 3);
    expect(unwrap(await service.startPass({ kind: 'added', after: F2 }))).toMatchObject({
      end: 'interrupted',
      pages: 1,
    });

    unwrap(await service.acceptPass());
    expect(service.snapshot()).toMatchObject({ canResume: false, canAccept: false });
    expect(service.snapshot().session?.passes.at(-1)).toMatchObject({
      kind: 'added',
      state: 'accepted',
    });
    expect(keysOf(service.snapshot())).toEqual([F1, B1, F2, A1, B2, F3, B3]);
  });
});
