import { describe, expect, it } from 'vitest';
import { probeScanner, type ConnectedScanner } from '../../src/core/escl/connect';
import type { ScanJobLimits } from '../../src/core/escl/scan-job';
import { openPassService, type PassServiceOptions } from '../../src/core/scan/pass-service';
import type { Snapshot } from '../../src/shared';
import type { Scenario } from '../emulator/scenarios';
import { startTestEmulator } from '../support/emulator';
import { journalOnDisk, rolesOf } from '../support/session-store';
import { makeTempDataRoot } from '../support/temp-data-root';
import { unwrap } from '../support/result';

// Добавленный набор на настоящей цепочке (план M3.5, U3; KTD-5): эмулятор с лотками по заданиям
// → служба прохода с намерением → хранилище пишет роль и якорь → сборка ставит набор за якорем.
// Обрыв добавленного прохода и его досканирование — тем же проходом, со счётчиком без «из M».

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

const F2 = 'p01-s01-0002';

async function connect(scenario: Partial<Scenario>) {
  const emulator = await startTestEmulator({ scenario });
  const connected: ConnectedScanner = unwrap(
    await probeScanner({ ...emulator, fingerprint: null }),
  );
  const root = await makeTempDataRoot();
  const snapshots: Snapshot[] = [];
  const service = await openPassService(root, {
    ...OPTIONS,
    onChange: () => {
      snapshots.push(service.snapshot());
    },
  });
  await service.useScanner(connected);
  // Лицевые 1–2, обороты обратным порядком.
  expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 2 });
  expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 2 });
  return { emulator, root, service, snapshots };
}

describe('добавленный набор через эмулятор (M3.5, U3)', () => {
  it('набор после лица 2: роль и якорь в журнале, страницы за якорем, отчёт пар прежний', async () => {
    const { root, service, snapshots } = await connect({
      trays: [
        [1, 2],
        [4, 3],
        [5, 6],
      ],
    });

    expect(unwrap(await service.startPass({ kind: 'added', after: F2 }))).toMatchObject({
      end: 'completed',
      pages: 2,
    });

    const journal = await journalOnDisk(root);
    expect(rolesOf(journal.passes)).toEqual([
      [1, 'fronts', null],
      [2, 'backs', null],
      [3, 'added', F2],
    ]);
    const snapshot = service.snapshot();
    expect(snapshot.assembly?.order.map((page) => [page.key, page.addedSet])).toEqual([
      ['p01-s01-0001', null],
      ['p02-s01-0002', null],
      [F2, null],
      ['p03-s01-0001', 1],
      ['p03-s01-0002', 1],
      ['p02-s01-0001', null],
    ]);
    expect(snapshot.assembly?.report).toMatchObject({
      fronts: 2,
      backs: 2,
      mismatch: false,
    });
    // Экран `scan` видел добавленный проход без «из M».
    const running = snapshots.map((it) => it.pass).filter((pass) => pass?.kind === 'added');
    expect(running.length).toBeGreaterThan(0);
    expect(running.every((pass) => pass?.expected === null && !pass.resumed)).toBe(true);
  });

  it('обрыв со страницами: проход прерван, досканируется тем же проходом без «из M»; якорь цел', async () => {
    const { emulator, root, service, snapshots } = await connect({
      trays: [
        [1, 2],
        [4, 3],
        [5, 6, 7],
      ],
      // Сквозной счёт листов: пятый лист — первый добавленного набора; сбой на шестом.
      fault: { sheet: 6, kind: 'gone' },
    });

    expect(unwrap(await service.startPass({ kind: 'added', after: F2 }))).toMatchObject({
      end: 'interrupted',
      pages: 1,
    });
    expect(service.snapshot()).toMatchObject({ canResume: true, canAccept: true });
    // Поверх прерванного добавлять нельзя — сначала досканировать или принять.
    expect(await service.startPass({ kind: 'added', after: null })).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'passInterrupted' } },
    });

    emulator.clearJam();
    emulator.reloadTray([6, 7]);
    const before = snapshots.length;
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 2 });

    const resumed = snapshots
      .slice(before)
      .map((it) => it.pass)
      .filter((pass) => pass !== null);
    expect(resumed.length).toBeGreaterThan(0);
    expect(
      resumed.every((pass) => pass.kind === 'added' && pass.expected === null && pass.resumed),
    ).toBe(true);
    const journal = await journalOnDisk(root);
    expect(journal.passes.at(-1)).toMatchObject({ number: 3, kind: 'added', after: F2 });
    expect(journal.passes.at(-1)?.segments.map((segment) => segment.pageCount)).toEqual([1, 2]);
    expect(service.snapshot().assembly?.order.map((page) => page.key)).toEqual([
      'p01-s01-0001',
      'p02-s01-0002',
      F2,
      'p03-s01-0001',
      'p03-s02-0001',
      'p03-s02-0002',
      'p02-s01-0001',
    ]);
  });

  it('обрыв до первой страницы: добавленный проход отброшен, сессия и лента прежние', async () => {
    const { root, service } = await connect({
      trays: [
        [1, 2],
        [4, 3],
        [5, 6],
      ],
      fault: { sheet: 5, kind: 'gone' },
    });
    const before = service.snapshot().assembly?.order.map((page) => page.key);

    // Проход не состоялся, но сессия цела: отчёт «прерван» с нулём страниц и причиной (как у
    // оборотов в M2); пустой проход хранилище отбрасывает.
    expect(await service.startPass({ kind: 'added', after: F2 })).toMatchObject({
      ok: true,
      value: { end: 'interrupted', pages: 0, error: { code: 'scanFeedFailed' } },
    });

    expect((await journalOnDisk(root)).passes.map((pass) => pass.number)).toEqual([1, 2]);
    expect(service.snapshot().assembly?.order.map((page) => page.key)).toEqual(before);
    expect(service.snapshot()).toMatchObject({ canResume: false, canAccept: false });
  });
});
