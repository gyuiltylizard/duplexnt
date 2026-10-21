import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
import { layoutOf } from '../../src/core/storage/layout';
import { SCENARIOS, type Scenario } from '../emulator/scenarios';
import { startTestEmulator } from '../support/emulator';
import {
  pageFixture,
  pageFixtureNumberOf,
  pdfImageStreams,
  readFixture,
  ET_3850,
} from '../support/fixtures';
import { journalOnDisk } from '../support/session-store';
import { makeTempDataRoot } from '../support/temp-data-root';
import { unwrap } from '../support/result';
import { until } from '../support/until';

// Раздельные наборы — полный путь на настоящей цепочке (план M3.6, U7; R27): эмулятор с лотками
// по заданиям → служба → журнал v5 → режим наборов в снимке → «Добавить» в группу якоря → перенос
// через границу (явная граница) → «Собрать документ» → запись сборки → PDF → перезапуск до и
// после сборки. Приёмочные примеры плана: AE1–AE7, AE9, AE11–AE13. Сценарии эмулятора — те же,
// что у `npm run emulator` и CDP-смоука.

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

// Лица 1–3; обороты подаются обратным порядком: первый оборот прохода — оборот последнего листа.
const F1 = 'p01-s01-0001';
const F2 = 'p01-s01-0002';
const F3 = 'p01-s01-0003';
const B_FIRST = 'p02-s01-0001';
const B_SECOND = 'p02-s01-0002';
const B_THIRD = 'p02-s01-0003';
const A1 = 'p03-s01-0001';

async function connect(scenario: Partial<Scenario>) {
  const emulator = await startTestEmulator({ scenario });
  const connected: ConnectedScanner = unwrap(
    await probeScanner({ ...emulator, fingerprint: null }),
  );
  const root = await makeTempDataRoot();
  const service = await openPassService(root, OPTIONS);
  await service.useScanner(connected);
  const restart = async (): Promise<PassService> => {
    const again = await openPassService(root, OPTIONS);
    await again.useScanner(connected);
    return again;
  };
  return { emulator, connected, root, service, restart };
}

const keysOf = (snapshot: Snapshot): string[] =>
  snapshot.assembly?.order.map((page) => page.key) ?? [];

/** Сторона и место каждой страницы ленты: «1л», «2о», … */
const shapeOf = (snapshot: Snapshot): string[] =>
  snapshot.assembly?.order.map(
    (page) => `${String(page.sheet ?? '?')}${page.side === 'back' ? 'о' : 'л'}`,
  ) ?? [];

/** Какая фикстурная страница лежит на каждой странице PDF — порядок в файле сверяется точно. */
async function pdfFixtures(path: string): Promise<number[]> {
  const streams = await pdfImageStreams(await readFile(path));
  return streams.map((stream) => pageFixtureNumberOf(stream.contents));
}

/** Побайтовая сверка видимой ленты с ожидаемыми фикстурами. */
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

async function scanned(service: PassService, ...pages: readonly number[]): Promise<void> {
  for (const count of pages) {
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: count });
  }
}

async function saveSingle(service: PassService, root: string): Promise<string> {
  const folder = join(root, 'выход');
  await mkdir(folder, { recursive: true });
  const saved = unwrap(
    await service.saveDocuments(folder, { mode: 'single', names: ['Документ'], retry: false }),
  );
  expect(saved.failed).toEqual([]);
  return join(folder, 'Документ.pdf');
}

describe('раздельные наборы — полный путь через эмулятор (M3.6, U7)', () => {
  it('F1 / AE1–AE4, AE11: 3/2 → наборы → «Один лист · После текущей» → перенос через границу и обратно → «Собрать» → PDF 1,4,2,5,3,6 → saved', async () => {
    const { service, root } = await connect(SCENARIOS['separate-sets-missing']);
    await scanned(service, 3, 2);

    // AE1: режим наборов — лица в порядке сканирования, обороты обратным порядком подачи;
    // сторона и место — по группе; документ один, разрезов нет.
    let snapshot = service.snapshot();
    expect(snapshot.assembly?.report).toMatchObject({
      mode: 'sets',
      groups: { fronts: 3, backs: 2, divider: 3 },
      fronts: 3,
      backs: 2,
      backsState: 'completed',
      mismatch: true,
    });
    expect(keysOf(snapshot)).toEqual([F1, F2, F3, B_SECOND, B_FIRST]);
    expect(shapeOf(snapshot)).toEqual(['1л', '2л', '3л', '1о', '2о']);
    expect(snapshot.assembly?.documents).toEqual([{ name: '', start: 0, count: 5 }]);
    await expectAssembledFixtures(root, snapshot, [1, 2, 3, 4, 6]);

    // Сохранить несобранное нельзя (R16); собрать неуравненное — тоже (R13).
    expect(
      await service.saveDocuments(join(root, 'выход'), {
        mode: 'single',
        names: ['x'],
        retry: false,
      }),
    ).toMatchObject({
      ok: false,
      error: { details: { reason: 'notAssembled' } },
    });
    expect(await service.assemble()).toMatchObject({
      ok: false,
      error: { details: { reason: 'setsUnequal' } },
    });

    // AE2: текущая — оборот листа 1 (первый в наборе оборотов); «Один лист · После текущей»
    // ставит недостающий оборот листа 2 за ним, в группу оборотов.
    expect(unwrap(await service.startPass({ kind: 'added', after: B_SECOND }))).toMatchObject({
      end: 'completed',
      pages: 1,
    });
    snapshot = service.snapshot();
    expect(keysOf(snapshot)).toEqual([F1, F2, F3, B_SECOND, A1, B_FIRST]);
    expect(shapeOf(snapshot)).toEqual(['1л', '2л', '3л', '1о', '2о', '3о']);
    expect(snapshot.assembly?.sets).toEqual({ fronts: 3, backs: 3, divider: 3 });
    expect(snapshot.assembly?.order[4]).toMatchObject({ key: A1, addedSet: 1 });
    // Режим прежний: модалка `mismatch` уместна и при добавленном наборе (R20).
    expect(snapshot.assembly?.report).toMatchObject({ mode: 'sets', backsState: 'completed' });

    // AE3: лицо 3 — в обороты (явная граница 2) и обратно (граница 3 = авто → null).
    const across: SessionEdits = {
      ...EMPTY_EDITS,
      order: [F1, F2, F3, B_SECOND, A1, B_FIRST],
      divider: 2,
    };
    unwrap(await service.setEdits(across, false));
    snapshot = service.snapshot();
    expect(snapshot.assembly?.sets).toEqual({ fronts: 2, backs: 4, divider: 2 });
    expect(shapeOf(snapshot)).toEqual(['1л', '2л', '1о', '2о', '3о', '4о']);
    expect(snapshot.session?.edits.divider).toBe(2);
    expect(snapshot.assembly).toMatchObject({ hasEdits: true, orderEdited: true });
    unwrap(await service.setEdits({ ...across, divider: 3 }, false));
    snapshot = service.snapshot();
    expect(snapshot.assembly?.sets).toEqual({ fronts: 3, backs: 3, divider: 3 });
    expect(snapshot.session?.edits.divider).toBeNull();

    // AE4: «Собрать документ» — запись чередованием, порядок и граница обнулены.
    expect(await service.assemble()).toEqual({ ok: true, value: undefined });
    snapshot = service.snapshot();
    expect(snapshot.session?.assembled).toEqual([F1, B_SECOND, F2, A1, F3, B_FIRST]);
    expect(snapshot.session?.edits).toEqual(EMPTY_EDITS);
    expect(snapshot.assembly?.report).toMatchObject({
      mode: 'assembled',
      groups: null,
      mismatch: false,
    });
    expect(snapshot.assembly?.sets).toBeNull();
    expect(shapeOf(snapshot)).toEqual(['1л', '1о', '2л', '2о', '3л', '3о']);
    expect(snapshot.assembly?.hasEdits).toBe(false);
    await expectAssembledFixtures(root, snapshot, [1, 4, 2, 5, 3, 6]);
    expect(await service.assemble()).toMatchObject({
      ok: false,
      error: { details: { reason: 'notSeparate' } },
    });

    // AE11: PDF — страницы в порядке записи сборки; `saved` после записи.
    expect(await pdfFixtures(await saveSingle(service, root))).toEqual([1, 4, 2, 5, 3, 6]);
    expect(service.snapshot().session?.saved).toBe(true);

    // AE5 / AE6: после сборки правки обычные; «Вернуть» — к записи сборки.
    unwrap(
      await service.setEdits(
        { ...EMPTY_EDITS, deleted: [B_SECOND], rotations: { [F2]: 90 } },
        false,
      ),
    );
    snapshot = service.snapshot();
    expect(keysOf(snapshot)).toEqual([F1, F2, A1, F3, B_FIRST]);
    expect(snapshot.session?.saved).toBe(false);
    unwrap(await service.setEdits(EMPTY_EDITS, false));
    expect(keysOf(service.snapshot())).toEqual([F1, B_SECOND, F2, A1, F3, B_FIRST]);
  });

  it('AE7: перезапуск до сборки — граница и правки живы, модалка уместна; после сборки — запись жива, режим «собрано»', async () => {
    const { service, restart } = await connect(SCENARIOS['separate-sets-missing']);
    await scanned(service, 3, 2);
    unwrap(await service.setEdits({ ...EMPTY_EDITS, deleted: [F1], divider: 1 }, true));

    const second = await restart();
    let snapshot = second.snapshot();
    expect(snapshot.session?.edits).toMatchObject({ deleted: [F1], divider: 1 });
    expect(snapshot.session?.passes.find((pass) => pass.kind === 'backs')?.rotate180).toBe(true);
    expect(snapshot.assembly?.report).toMatchObject({
      mode: 'sets',
      groups: { fronts: 1, backs: 3, divider: 1 },
      backsState: 'completed',
    });
    expect(keysOf(snapshot)).toEqual([F2, F3, B_SECOND, B_FIRST]);

    // Уравнять: лицо 3 — в обороты не нужно; наоборот, вернуть границу 2 и удалить лишний
    // оборот: 2/1 → удалить F3 → 1/1? Проще: граница 2 (F2, F3 | обороты) и удалить один оборот.
    unwrap(await second.setEdits({ ...EMPTY_EDITS, deleted: [F1, B_FIRST], divider: 2 }, true));
    expect(second.snapshot().assembly?.sets).toEqual({ fronts: 2, backs: 1, divider: 2 });
    unwrap(await second.setEdits({ ...EMPTY_EDITS, deleted: [F1, B_FIRST, F3], divider: 1 }, true));
    expect(second.snapshot().assembly?.sets).toEqual({ fronts: 1, backs: 1, divider: 1 });
    unwrap(await second.assemble());
    snapshot = second.snapshot();
    // Удалённые — за ближайшим видимым предшественником полного порядка (R7): F1 без
    // предшественника — в начало; F3 — за F2; B_FIRST — за B_SECOND.
    expect(snapshot.session?.assembled).toEqual([F1, F2, F3, B_SECOND, B_FIRST]);
    expect(keysOf(snapshot)).toEqual([F2, B_SECOND]);

    const third = await restart();
    snapshot = third.snapshot();
    expect(snapshot.session?.assembled).toEqual([F1, F2, F3, B_SECOND, B_FIRST]);
    expect(snapshot.assembly?.report).toMatchObject({ mode: 'assembled', mismatch: false });
    expect(shapeOf(snapshot)).toEqual(['1л', '1о']);
    // «Вернуть» после перезапуска — к записи: удалённые на местах, листы по позиции.
    unwrap(await third.setEdits(EMPTY_EDITS, false));
    expect(keysOf(third.snapshot())).toEqual([F1, F2, F3, B_SECOND, B_FIRST]);
  });

  it('AE9: лишний оборот → удаление → «Собрать» → 2 листа', async () => {
    const { service, root } = await connect(SCENARIOS['separate-sets-extra']);
    await scanned(service, 2, 3);

    let snapshot = service.snapshot();
    expect(snapshot.assembly?.report).toMatchObject({
      mode: 'sets',
      groups: { fronts: 2, backs: 3, divider: 2 },
      fronts: 2,
      backs: 3,
    });
    // Обороты обратным порядком подачи: 4 (лист 1), 5 (лист 2), 6 (лишний — последний).
    expect(keysOf(snapshot)).toEqual([F1, F2, B_THIRD, B_SECOND, B_FIRST]);
    await expectAssembledFixtures(root, snapshot, [1, 2, 4, 5, 6]);
    expect(await service.assemble()).toMatchObject({
      ok: false,
      error: { details: { reason: 'setsUnequal' } },
    });

    unwrap(await service.setEdits({ ...EMPTY_EDITS, deleted: [B_FIRST] }, false));
    expect(service.snapshot().assembly?.sets).toEqual({ fronts: 2, backs: 2, divider: 2 });
    unwrap(await service.assemble());
    snapshot = service.snapshot();
    expect(snapshot.session?.assembled).toEqual([F1, B_THIRD, F2, B_SECOND, B_FIRST]);
    expect(shapeOf(snapshot)).toEqual(['1л', '1о', '2л', '2о']);
    expect(await pdfFixtures(await saveSingle(service, root))).toEqual([1, 4, 2, 5]);
  });

  it('AE12: замятие в проходе оборотов → наборы с прерванным проходом → досканирование в группу оборотов → «Собрать»', async () => {
    const { service, emulator, root } = await connect(SCENARIOS['separate-sets-jam']);
    unwrap(await service.startPass(null));
    expect(await service.startPass(null)).toMatchObject({
      ok: true,
      value: { end: 'interrupted', pages: 1 },
    });

    // Режим наборов при любом состоянии прохода со страницами, кроме идущего (R4).
    let snapshot = service.snapshot();
    expect(snapshot.assembly?.report).toMatchObject({
      mode: 'sets',
      groups: { fronts: 3, backs: 1, divider: 3 },
      backsState: 'interrupted',
    });
    expect(snapshot.canResume).toBe(true);
    expect(await service.assemble()).toMatchObject({
      ok: false,
      error: { details: { reason: 'passInterrupted' } },
    });

    // «Досканировать остаток» — человек положил только один лист: оборотов стало 2.
    emulator.clearJam();
    emulator.reloadTray([5]);
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 1 });
    snapshot = service.snapshot();
    expect(snapshot.assembly?.report).toMatchObject({
      mode: 'sets',
      groups: { fronts: 3, backs: 2, divider: 3 },
      backsState: 'completed',
    });
    // Досканированный сегмент — в конец блока прохода, то есть в начало группы оборотов (F5).
    expect(keysOf(snapshot)).toEqual([F1, F2, F3, 'p02-s02-0001', B_FIRST]);
    await expectAssembledFixtures(root, snapshot, [1, 2, 3, 5, 6]);

    // Оборота листа 1 нет — удалить лицо 1, собрать: 2 листа.
    unwrap(await service.setEdits({ ...EMPTY_EDITS, deleted: [F1] }, false));
    unwrap(await service.assemble());
    snapshot = service.snapshot();
    expect(snapshot.session?.assembled).toEqual([F1, F2, 'p02-s02-0001', F3, B_FIRST]);
    expect(await pdfFixtures(await saveSingle(service, root))).toEqual([2, 5, 3, 6]);
  });

  it('AE4 (принят коротким): «Оставить как есть» — наборы, модалка уместна; добавление в группу оборотов уравнивает', async () => {
    const { service } = await connect(SCENARIOS['separate-sets-jam']);
    unwrap(await service.startPass(null));
    await service.startPass(null);
    unwrap(await service.acceptPass());

    let snapshot = service.snapshot();
    expect(snapshot.assembly?.report).toMatchObject({
      mode: 'sets',
      groups: { fronts: 3, backs: 1, divider: 3 },
      backsState: 'accepted',
      mismatch: true,
    });
    // Принятый коротким проход — всё равно наборы: собирать нельзя, пока не уравнены.
    expect(await service.assemble()).toMatchObject({
      ok: false,
      error: { details: { reason: 'setsUnequal' } },
    });
    snapshot = service.snapshot();
    expect(keysOf(snapshot)).toEqual([F1, F2, F3, B_FIRST]);
  });

  it('«Остановить» на первом листе добавленного прохода в режиме наборов — лента и граница прежние', async () => {
    const { service, emulator } = await connect({
      ...SCENARIOS['separate-sets-missing'],
      trays: [
        [1, 2, 3],
        [6, 4],
        [5, 7],
      ],
      pageDelayMs: 150,
    });
    await scanned(service, 3, 2);
    const across: SessionEdits = {
      ...EMPTY_EDITS,
      order: [F1, F2, F3, B_SECOND, B_FIRST],
      divider: 2,
    };
    unwrap(await service.setEdits(across, false));
    const before = service.snapshot();

    const added = service.startPass({ kind: 'added', after: F1 });
    await until(() => service.snapshot().pass?.kind === 'added');
    expect(await service.stopPass()).toEqual({ ok: true, value: undefined });
    expect(unwrap(await added)).toMatchObject({ end: 'stopped' });

    const after = service.snapshot();
    expect(after.session?.passes.map((pass) => pass.kind)).toEqual(['fronts', 'backs']);
    expect(keysOf(after)).toEqual(keysOf(before));
    expect(after.session?.edits).toEqual(before.session?.edits);
    expect(after.assembly?.sets).toEqual({ fronts: 2, backs: 3, divider: 2 });
    await emulator.close();
  });

  it('AE13: журнал v4 с несовпадением и разрезами → v5, режим наборов, разрезов и имён нет', async () => {
    const root = await makeTempDataRoot();
    const layout = layoutOf(root);
    await mkdir(layout.pagesDir, { recursive: true });
    const passOf = (number: number, kind: 'fronts' | 'backs', pages: number) => ({
      number,
      accepted: false,
      origin: null,
      nextSegment: 2,
      segments: [{ number: 1, state: 'completed', pageCount: pages }],
      rotate180: false,
      kind,
      after: null,
    });
    await writeFile(
      layout.journalFile,
      JSON.stringify({
        version: 4,
        sessionId: 'a1b2c3d4e5f60718',
        nextPass: 3,
        passes: [passOf(1, 'fronts', 3), passOf(2, 'backs', 2)],
        deletions: [],
        backsDeclined: false,
        saved: false,
        edits: { ...EMPTY_EDITS_V4, cuts: [1], names: ['Счёт', 'Акт'], rotations: { [F2]: 90 } },
      }),
    );
    for (const [pass, count] of [
      [1, 3],
      [2, 2],
    ] as const) {
      for (let index = 1; index <= count; index += 1) {
        const name = `p0${String(pass)}-s01-${String(index).padStart(4, '0')}.jpg`;
        await writeFile(
          join(layout.pagesDir, name),
          readFixture(...ET_3850, 'pages', `page-0${String(index)}.jpg`),
        );
      }
    }

    const service = await openPassService(root, OPTIONS);
    const snapshot = service.snapshot();
    expect(snapshot.assembly?.report).toMatchObject({
      mode: 'sets',
      groups: { fronts: 3, backs: 2, divider: 3 },
    });
    // Разрезы и имена обнулены нормализацией (R8), поворот цел; на диске — v5 с дефолтами.
    expect(snapshot.session?.edits).toEqual({
      ...EMPTY_EDITS,
      rotations: { [F2]: 90 },
    });
    expect(snapshot.session?.assembled).toBeNull();
    expect(snapshot.assembly?.documents).toEqual([{ name: '', start: 0, count: 5 }]);
    const journal = await journalOnDisk(root);
    expect(journal).toMatchObject({
      version: 5,
      assembled: null,
      edits: { divider: null, cuts: [], names: [''] },
    });
  });
});

/** Правки журнала v4 — без границы наборов. */
const EMPTY_EDITS_V4 = { order: [], deleted: [], rotations: {}, cuts: [], names: [''] };
