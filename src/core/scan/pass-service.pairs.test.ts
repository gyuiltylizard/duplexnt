import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EMPTY_EDITS, fail } from '@shared';
import { describe, expect, it } from 'vitest';
import { ET_3850, readFixture } from '../../../test/support/fixtures';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import { parseCapabilities } from '../escl/capabilities';
import type { ConnectedScanner, ConnectorOptions } from '../escl/connect';
import { scanOptionsOf } from '../escl/scan-settings';
import type { JournalPass, PassOrigin } from '../storage/journal';
import { layoutOf } from '../storage/layout';
import { openPassService } from './pass-service';

// Пара добавленного набора в службе прохода (план M4.5, U4; R4, R10, R15, R16): намерение лиц
// набора, обороты набора по очереди с «из F», сканер пары, команды решения набора через службу.
// Полный путь с эмулятором — test/integration/added-pair*.emulator.test.ts (U8).

const SESSION = 'a1b2c3d4e5f60718';
const PAGE = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);

function connected(): ConnectedScanner {
  const capabilities = parseCapabilities(readFixture(...ET_3850, 'ScannerCapabilities.xml'));
  if (!capabilities.ok) {
    throw new Error('фикстура capabilities не разобрана');
  }
  return {
    profile: {
      scheme: 'https',
      host: '127.0.0.1',
      port: 9443,
      basePath: '/eSCL',
      fingerprint: null,
    },
    capabilities: capabilities.value,
    options: scanOptionsOf(capabilities.value),
  };
}

/** Параметры прохода с другого сканера: досканировать на подключённом нельзя (KTD-27). */
const OTHER_SCANNER: PassOrigin = {
  scanner: {
    scheme: 'https',
    host: 'scanner.test',
    port: 443,
    basePath: '/eSCL',
    fingerprint: 'ab'.repeat(32),
    uuid: '00000000-0000-4000-8000-000000000001',
    name: 'Other Scanner',
  },
  params: { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' },
  pixelLimit: 5100 * 8400,
};

const passAt = (
  number: number,
  pageCount: number,
  extra: Partial<JournalPass> = {},
): JournalPass => ({
  number,
  accepted: false,
  origin: null,
  nextSegment: 2,
  segments: [{ number: 1, state: 'completed', pageCount }],
  kind: number === 1 ? 'fronts' : 'backs',
  after: null,
  pair: null,
  backsDecision: null,
  rotate180: false,
  ...extra,
});

const MAIN: readonly JournalPass[] = [passAt(1, 3), passAt(2, 3)];
const setFronts = (count: number, extra: Partial<JournalPass> = {}): JournalPass =>
  passAt(3, count, { kind: 'addedFronts', after: 'p01-s01-0002', backsDecision: 'none', ...extra });
const setBacks = (count: number, extra: Partial<JournalPass> = {}): JournalPass =>
  passAt(4, count, { kind: 'addedBacks', pair: 3, ...extra });

/** Сессия на диске: журнал v7 и файлы страниц всех проходов. */
async function seed(passes: readonly JournalPass[], extra: Record<string, unknown> = {}) {
  const root = await makeTempDataRoot();
  const layout = layoutOf(root);
  await mkdir(layout.pagesDir, { recursive: true });
  await writeFile(
    layout.journalFile,
    JSON.stringify({
      version: 7,
      sessionId: SESSION,
      nextPass: Math.max(...passes.map((pass) => pass.number)) + 1,
      passes,
      deletions: [],
      backsDeclined: false,
      saved: false,
      edits: EMPTY_EDITS,
      assembled: null,
      blankMode: 'keep',
      ...extra,
    }),
  );
  for (const pass of passes) {
    for (let index = 1; index <= (pass.segments[0]?.pageCount ?? 0); index += 1) {
      const name = `p${String(pass.number).padStart(2, '0')}-s01-${String(index).padStart(4, '0')}.jpg`;
      await writeFile(join(layout.pagesDir, name), PAGE);
    }
  }
  return { root, layout };
}

/** Транспорт, отвечающий отказом сети: дошли до него — политика проход пропустила. */
function refusingConnector() {
  const requests: string[] = [];
  const connector: ConnectorOptions = {
    createTransport: () => ({
      request: (options) => {
        requests.push(options.path);
        return Promise.resolve(fail('scannerUnreachable', { reason: 'refused' }));
      },
      stream: () => Promise.resolve(fail('scannerUnreachable', { reason: 'refused' })),
      close: () => undefined,
    }),
  };
  return { requests, connector };
}

/** Транспорт, который держит первый запрос до `release`: снимок идущего прохода виден снаружи. */
function gatedConnector() {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const connector: ConnectorOptions = {
    createTransport: () => ({
      request: async () => {
        await gate;
        return fail('scannerUnreachable', { reason: 'refused' });
      },
      stream: () => Promise.resolve(fail('scannerUnreachable', { reason: 'refused' })),
      close: () => undefined,
    }),
  };
  return { connector, release };
}

async function serviceOver(root: string, connector: ConnectorOptions) {
  const service = await openPassService(root, { connector });
  await service.useScanner(connected());
  return service;
}

const conflict = (reason: string) => fail('sessionConflict', { reason });

describe('служба прохода: пара добавленного набора (M4.5, U4; R4, R11)', () => {
  it('намерение лиц набора: роль addedFronts в снимке идущего прохода, счётчик без «из M»', async () => {
    const { root } = await seed(MAIN);
    const { connector, release } = gatedConnector();
    const service = await serviceOver(root, connector);

    const pass = service.startPass({ kind: 'addedFronts', after: 'p01-s01-0002' });
    expect(service.snapshot().pass).toMatchObject({
      kind: 'addedFronts',
      expected: null,
      resumed: false,
    });
    release();
    await pass;
    expect(service.snapshot().pass).toBeNull();
  });

  it('набор ждёт обороты: запуск без намерения — обороты набора с «из F»; отказ до первой страницы оставляет набор ждущим', async () => {
    const { root } = await seed([...MAIN, setFronts(2)]);
    const { connector, release } = gatedConnector();
    const service = await serviceOver(root, connector);
    expect(service.snapshot().assembly?.report.pendingSet).toBe(1);

    const pass = service.startPass(null);
    expect(service.snapshot().pass).toMatchObject({
      kind: 'addedBacks',
      expected: 2,
      resumed: false,
    });
    release();
    expect(await pass).toMatchObject({ ok: false, error: { code: 'scannerUnreachable' } });

    // Проход без страниц отброшен: набор по-прежнему ждёт обороты, нового прохода в журнале нет.
    expect(service.snapshot().assembly?.report.pendingSet).toBe(1);
    expect(service.snapshot().session?.passes.map((pass) => pass.number)).toEqual([1, 2, 3]);
  });

  it('обороты набора идут на текущем сканере с его параметрами (AE14): отказ приходит от сети, не политики', async () => {
    const { root } = await seed([...MAIN, setFronts(2, { origin: OTHER_SCANNER })]);
    const { requests, connector } = refusingConnector();
    const service = await serviceOver(root, connector);

    expect(await service.startPass(null)).toEqual(
      fail('scannerUnreachable', { reason: 'refused' }),
    );
    expect(requests.length).toBeGreaterThan(0);
  });

  it('досканирование прерванного прохода набора — только на его сканере: otherScanner до сети (KTD-27)', async () => {
    const { root } = await seed([
      ...MAIN,
      setFronts(3),
      setBacks(1, {
        origin: OTHER_SCANNER,
        segments: [{ number: 1, state: 'interrupted', pageCount: 1 }],
      }),
    ]);
    const { requests, connector } = refusingConnector();
    const service = await serviceOver(root, connector);

    expect(await service.startPass(null)).toEqual(conflict('otherScanner'));
    expect(requests).toEqual([]);
    expect(service.snapshot()).toMatchObject({ canResume: false, canAccept: true });
  });
});

describe('служба прохода: решения по оборотам набора (M4.5, U4; KTD3)', () => {
  it('keepSetBacks: решение видно в снимке и отчёте сборки; повтор — setNotMismatched; без набора — noPendingSet', async () => {
    const { root } = await seed([...MAIN, setFronts(3), setBacks(2)]);
    const service = await openPassService(root);
    const before = service.snapshot().seq;
    expect(service.snapshot().assembly?.report.sets[0]).toMatchObject({
      mismatch: true,
      decision: 'none',
    });

    expect(await service.keepSetBacks(1)).toEqual({ ok: true, value: undefined });

    expect(service.snapshot().seq).toBeGreaterThan(before);
    expect(service.snapshot().assembly?.report.sets[0]).toMatchObject({ decision: 'kept' });
    expect(service.snapshot().session?.passes[2]).toMatchObject({ backsDecision: 'kept' });
    expect(await service.keepSetBacks(1)).toEqual(conflict('setNotMismatched'));
    expect(await service.rescanSetBacks(1)).toEqual(conflict('setNotMismatched'));
    expect(await service.keepSetBacks(5)).toEqual(conflict('noPendingSet'));
  });

  it('rescanSetBacks: проход оборотов набора исчезает из снимка и с диска, набор снова ждёт обороты', async () => {
    const { root, layout } = await seed([...MAIN, setFronts(3), setBacks(2)]);
    const service = await openPassService(root);

    expect(await service.rescanSetBacks(1)).toEqual({ ok: true, value: undefined });

    const snapshot = service.snapshot();
    expect(snapshot.session?.passes.map((pass) => pass.number)).toEqual([1, 2, 3]);
    expect(snapshot.assembly?.report).toMatchObject({ pendingSet: 1, sets: [{ backs: 0 }] });
    expect(snapshot.assembly?.order.map((page) => page.key)).not.toContain('p04-s01-0001');
    expect((await readdir(layout.pagesDir)).filter((name) => name.startsWith('p04-'))).toEqual([]);
    expect(await service.rescanSetBacks(1)).toEqual(conflict('noPendingSet'));
  });

  it('во время прохода решения по набору отклоняются passRunning (KTD-9)', async () => {
    const { root } = await seed([...MAIN, setFronts(3), setBacks(2)]);
    const { connector, release } = gatedConnector();
    const service = await serviceOver(root, connector);

    const pass = service.startPass({ kind: 'added', after: null });
    expect(await service.keepSetBacks(1)).toEqual(conflict('passRunning'));
    expect(await service.rescanSetBacks(1)).toEqual(conflict('passRunning'));
    release();
    await pass;
    expect(await service.keepSetBacks(1)).toEqual({ ok: true, value: undefined });
  });
});
