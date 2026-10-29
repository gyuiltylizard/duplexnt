import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeScanner, type ConnectedScanner } from '../../src/core/escl/connect';
import type { ScanJobLimits } from '../../src/core/escl/scan-job';
import {
  openPassService,
  type PassService,
  type PassServiceOptions,
} from '../../src/core/scan/pass-service';
import {
  createTransport,
  type ScannerProfile,
  type ScannerTransport,
  type TransportLimits,
} from '../../src/core/escl/transport';
import { layoutOf } from '../../src/core/storage/layout';
import { realStorageFs, type StorageFs } from '../../src/core/storage/storage-fs';
import type { DomainError, Result, Snapshot } from '../../src/shared';
import type { Scenario } from '../emulator/scenarios';
import { dirSnapshot } from '../support/dir-snapshot';
import { startTestEmulator } from '../support/emulator';
import { pageFixture } from '../support/fixtures';
import { unwrap } from '../support/result';
import { until } from '../support/until';
import { noSearch } from '../support/uuid-search';
import { fsError, interceptFs } from '../support/intercept-fs';
import { makeTempDataRoot } from '../support/temp-data-root';
import { levelWorker } from '../support/image-worker';

// Служба прохода на настоящей цепочке (план M1, U17): эмулятор сканера по HTTPS → клиент →
// хранилище во временном корне данных. Каждый сценарий плана — своим тестом; «перезапуск» —
// новая служба над тем же корнем.

// Те же правила, что в продукте, но время сжато.
const FAST: Partial<ScanJobLimits> = {
  retryDelayMs: 5,
  busyCeilingMs: 200,
  notReadyCeilingMs: 2000,
  pageIdleTimeoutMs: 300,
  pageDeadlineMs: 3000,
  deleteDeadlineMs: 300,
};

const FAST_RETRY = { ceilingMs: 50 };

interface Harness {
  readonly root: string;
  readonly service: PassService;
  readonly snapshots: Snapshot[];
  readonly connected: ConnectedScanner;
  /** Новая служба над тем же корнем — «приложение запущено снова». */
  readonly restart: (options?: Partial<PassServiceOptions>) => Promise<Harness>;
}

async function connectTo(emulator: {
  scheme: 'https' | 'http';
  host: string;
  port: number;
  basePath: string;
}): Promise<ConnectedScanner> {
  const probed = await probeScanner({ ...emulator, fingerprint: null });
  if (!probed.ok) {
    throw new Error(`эмулятор не подключился: ${probed.error.code}`);
  }
  return probed.value;
}

async function open(
  root: string,
  connected: ConnectedScanner,
  options: Partial<PassServiceOptions> = {},
): Promise<Harness> {
  const snapshots: Snapshot[] = [];
  const service = await openPassService(root, {
    jobLimits: FAST,
    imageWorker: levelWorker,
    minFreeBytes: 1,
    retry: FAST_RETRY,
    findByUuid: noSearch,
    ...options,
    onChange: () => {
      snapshots.push(service.snapshot());
    },
  });
  await service.useScanner(connected);
  return {
    root,
    service,
    snapshots,
    connected,
    restart: (next = {}) => open(root, connected, next),
  };
}

async function setup(scenario: Partial<Scenario> = {}, options: Partial<PassServiceOptions> = {}) {
  const emulator = await startTestEmulator({ scenario });
  const root = await makeTempDataRoot();
  const connected = await connectTo(emulator);
  const harness = await open(root, connected, options);
  return { emulator, ...harness };
}

const errorOf = (result: Result<unknown>): DomainError | null => (result.ok ? null : result.error);

const pageFiles = async (root: string): Promise<string[]> => {
  try {
    return (await readdir(layoutOf(root).pagesDir)).sort();
  } catch {
    return [];
  }
};

const pageKeys = (snapshot: Snapshot): string[] =>
  snapshot.session?.passes.flatMap((pass) => pass.pages.map((page) => page.key)) ?? [];

/** Страницы прохода по порядку номеров побайтово равны фикстурам с первой по N-ю. */
async function expectPagesEqualFixtures(root: string, snapshot: Snapshot, count: number) {
  const pages = snapshot.session?.passes[0]?.pages ?? [];
  expect(pages.map((page) => page.number)).toEqual(
    Array.from({ length: count }, (_, index) => index + 1),
  );
  for (const page of pages) {
    const written = await readFile(join(layoutOf(root).pagesDir, `${page.key}.jpg`));
    expect(written.equals(pageFixture(page.number))).toBe(true);
  }
}

const journalOnDisk = async (root: string): Promise<unknown> =>
  JSON.parse(await readFile(layoutOf(root).journalFile, 'utf8'));

describe('служба прохода: проход против эмулятора', () => {
  it('AE1: N страниц побайтово равны фикстурам, проход завершён, снимок менялся на каждую', async () => {
    const { root, service, snapshots } = await setup({ sheets: 12 });

    const report = unwrap(await service.startPass(null));

    expect(report).toEqual({ end: 'completed', pages: 12, error: null });
    const snapshot = service.snapshot();
    expect(snapshot.pass).toBeNull();
    expect(snapshot.session?.passes.map((pass) => pass.state)).toEqual(['completed']);
    expect(snapshot.canResume).toBe(false);
    expect(snapshot.canAccept).toBe(false);
    await expectPagesEqualFixtures(root, snapshot, 12);
    // Снимок с каждым новым числом страниц — свой.
    const counted = snapshots.map((it) => it.pass?.pages ?? null).filter((it) => it !== null);
    expect([...new Set(counted)]).toEqual(Array.from({ length: 13 }, (_, index) => index));
    expect(snapshots.map((it) => it.pass?.phase).filter((it) => it !== undefined)).toContain(
      'scanning',
    );
    // Номера снимков растут.
    const seqs = snapshots.map((it) => it.seq);
    expect(seqs).toEqual([...new Set(seqs)].sort((left, right) => left - right));
  });

  it('снимок не несёт абсолютных путей и адресов заданий (KTD-39)', async () => {
    const { emulator, root, service } = await setup({ sheets: 2 });
    unwrap(await service.startPass(null));

    const text = JSON.stringify(service.snapshot());

    expect(text).not.toContain(root.replaceAll('\\', '\\\\'));
    expect(text).not.toContain('ScanJobs');
    expect(text).not.toContain(emulator.jobs()[0]?.path ?? '<job>');
  });

  it('AE3: после завершённого прохода перезапуск показывает те же страницы', async () => {
    const { root, service, restart } = await setup({ sheets: 3 });
    unwrap(await service.startPass(null));

    const again = await restart();

    expect(again.service.snapshot().session).toEqual(service.snapshot().session);
    await expectPagesEqualFixtures(root, again.service.snapshot(), 3);
  });

  it('AE6: занятость видна в снимке как ожидание, затем проход идёт', async () => {
    const { service, snapshots } = await setup({ sheets: 2, busyPosts: 3 });

    const report = unwrap(await service.startPass(null));

    expect(report.end).toBe('completed');
    const phases = snapshots.map((it) => it.pass?.phase ?? null);
    expect(phases).toContain('busy');
    expect(phases.indexOf('busy')).toBeLessThan(phases.indexOf('scanning'));
  });

  it('второй запуск, пока идёт проход, отклоняется; «Новая пачка» и «оставить» — тоже', async () => {
    const { emulator, service } = await setup({ sheets: 3, pageDelayMs: 100 });

    const running = service.startPass(null);
    await until(() => emulator.jobs().length === 1);
    const second = await service.startPass(null);
    const close = await service.closeSession();
    const accept = await service.acceptPass();
    unwrap(await running);

    for (const result of [second, close, accept]) {
      expect(errorOf(result)).toEqual({
        code: 'sessionConflict',
        details: { reason: 'passRunning' },
      });
    }
  });
});

describe('служба прохода: лоток и отказы до задания', () => {
  it('пустой лоток по статусу — отказ «нет бумаги» без задания и без сессии', async () => {
    const { emulator, root, service } = await setup({ sheets: 0 });

    const result = await service.startPass(null);

    expect(errorOf(result)).toEqual({ code: 'scanNoPaper' });
    expect(emulator.requests()).toEqual([
      'GET /eSCL/ScannerCapabilities 200',
      'GET /eSCL/ScannerStatus 200',
    ]);
    expect(service.snapshot().session).toBeNull();
    expect(await pageFiles(root)).toEqual([]);
  });

  it('ноль страниц при полном лотке по статусу — отказ «нет бумаги», сессия не создана', async () => {
    const { emulator, root, service } = await setup({ sheets: 0, trayReportsLoaded: true });

    const result = await service.startPass(null);

    expect(errorOf(result)).toEqual({ code: 'scanNoPaper' });
    expect(emulator.requests().at(-1)).toBe('DELETE /eSCL/ScanJobs/<job> 404');
    expect(service.snapshot().session).toBeNull();
    await expect(readdir(layoutOf(root).sessionDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('без подключённого сканера проход не начинается', async () => {
    const emulator = await startTestEmulator();
    const root = await makeTempDataRoot();
    const service = await openPassService(root, { jobLimits: FAST, imageWorker: levelWorker });

    expect(errorOf(await service.startPass(null))).toEqual({ code: 'scannerNotConnected' });
    expect(emulator.requests()).toEqual([]);
  });

  it('нехватка места перед проходом — отказ без задания', async () => {
    const { emulator, service } = await setup(
      { sheets: 3 },
      { minFreeBytes: Number.MAX_SAFE_INTEGER },
    );

    const result = await service.startPass(null);

    expect(errorOf(result)).toEqual({ code: 'storageFull' });
    expect(emulator.jobs()).toEqual([]);
    expect(service.snapshot().session).toBeNull();
  });

  it('занятость дольше потолка — отказ «занят», сегмент убран, сессии нет', async () => {
    const { root, service } = await setup({ sheets: 3, busyPosts: Infinity });

    const result = await service.startPass(null);

    expect(errorOf(result)).toEqual({ code: 'scannerBusy' });
    expect(service.snapshot()).toMatchObject({ session: null, pass: null });
    await expect(readFile(layoutOf(root).journalFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('режим отказа: старт прохода оставляет каталог побайтово прежним', async () => {
    const emulator = await startTestEmulator({ scenario: { sheets: 3 } });
    const root = await makeTempDataRoot();
    const { sessionDir, journalFile } = layoutOf(root);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(journalFile, JSON.stringify({ version: 2, future: true }));
    const harness = await open(root, await connectTo(emulator));
    const before = await dirSnapshot(root);

    const result = await harness.service.startPass(null);

    expect(errorOf(result)).toEqual({ code: 'storageIncompatible' });
    expect(harness.service.snapshot().storage.incompatible).toBe(true);
    expect(await dirSnapshot(root)).toEqual(before);
    expect(emulator.requests()).toEqual(['GET /eSCL/ScannerCapabilities 200']);
  });

  it('сертификат сменился между подключением и стартом — «другое устройство», задания нет', async () => {
    const { emulator, service, connected } = await setup({ sheets: 3 });
    await service.useScanner({
      ...connected,
      profile: { ...connected.profile, fingerprint: '00'.repeat(32) },
    });

    const result = await service.startPass(null);

    expect(errorOf(result)).toEqual({ code: 'scannerCertificateChanged' });
    expect(emulator.jobs()).toEqual([]);
    expect(service.snapshot().scanner.kind).toBe('otherDevice');
    expect(service.snapshot().session).toBeNull();
  });
});

describe('служба прохода: «Остановить»', () => {
  it('AE4: в первом сегменте — файлов нет, сессии нет', async () => {
    const { emulator, root, service, snapshots } = await setup({
      sheets: 5,
      fault: { sheet: 3, kind: 'stall' },
    });

    const running = service.startPass(null);
    await until(
      () => emulator.requests().filter((it) => it.endsWith('NextDocument 200')).length === 3,
    );
    const stopped = service.stopPass();
    expect(service.snapshot().pass?.phase).toBe('stopping');
    const report = unwrap(await running);

    expect(await stopped).toEqual({ ok: true, value: undefined });
    expect(report).toEqual({ end: 'stopped', pages: 0, error: null });
    expect(service.snapshot().session).toBeNull();
    expect(await pageFiles(root)).toEqual([]);
    expect(emulator.requests().at(-1)).toBe('DELETE /eSCL/ScanJobs/<job> 200');
    expect(snapshots.some((it) => it.pass?.phase === 'stopping')).toBe(true);
  });

  it('отмена во время ожидания занятости не оставляет ни прохода, ни сессии', async () => {
    const { emulator, root, service, snapshots } = await setup(
      { busyPosts: Infinity },
      {
        jobLimits: { ...FAST, retryDelayMs: 20, busyCeilingMs: 10_000 },
      },
    );

    const running = service.startPass(null);
    await until(() => snapshots.some((it) => it.pass?.phase === 'busy'));
    unwrap(await service.stopPass());
    const report = unwrap(await running);

    expect(report.end).toBe('stopped');
    expect(emulator.jobs()).toEqual([]);
    expect(service.snapshot().session).toBeNull();
    await expect(readFile(layoutOf(root).journalFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('«Остановить» до задания, пока читается лоток, — проход не начался', async () => {
    const { emulator, service } = await setup({ sheets: 3 });

    const running = service.startPass(null);
    unwrap(await service.stopPass());
    const report = unwrap(await running);

    expect(report).toEqual({ end: 'stopped', pages: 0, error: null });
    expect(emulator.jobs()).toEqual([]);
  });

  it('«Остановить», пришедшее после обрыва, отклоняется и ничего не удаляет', async () => {
    const { root, service } = await setup({ sheets: 5, fault: { sheet: 3, kind: 'gone' } });
    const report = unwrap(await service.startPass(null));
    const files = await pageFiles(root);

    const stop = await service.stopPass();

    expect(report.end).toBe('interrupted');
    expect(errorOf(stop)).toEqual({
      code: 'sessionConflict',
      details: { reason: 'noRunningPass' },
    });
    expect(await pageFiles(root)).toEqual(files);
    expect(files).toHaveLength(2);
  });

  it('в первом сегменте при неудавшемся закрытии каталога — проход прерван, страницы целы', async () => {
    const emulator = await startTestEmulator({
      scenario: { sheets: 5, fault: { sheet: 3, kind: 'stall' } },
    });
    const root = await makeTempDataRoot();
    const { sessionDir } = layoutOf(root);
    const { fs } = interceptFs<StorageFs>(realStorageFs, (call) => {
      if (call.op === 'rename' && call.path === sessionDir) {
        throw fsError('EPERM');
      }
    });
    const { service } = await open(root, await connectTo(emulator), { fs });

    const running = service.startPass(null);
    await until(
      () => emulator.requests().filter((it) => it.endsWith('NextDocument 200')).length === 3,
    );
    const stopped = await service.stopPass();
    const report = unwrap(await running);

    expect(errorOf(stopped)).toEqual({ code: 'sessionCloseFailed', details: { reason: 'EPERM' } });
    expect(report).toMatchObject({ end: 'interrupted', pages: 2 });
    expect(service.snapshot().session?.passes[0]?.state).toBe('interrupted');
    expect(await pageFiles(root)).toEqual(['p01-s01-0001.jpg', 'p01-s01-0002.jpg']);
  });
});

/**
 * Транспорт, который придерживает запросы с выбранным методом и путём до `release()`: так тест
 * ставит «Остановить» или подключение ровно туда, где запрос уже ушёл, а ответа ещё нет.
 */
function holdingTransport(matches: (method: string, path: string) => boolean) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  const create = (profile: ScannerProfile, limits?: Partial<TransportLimits>): ScannerTransport => {
    const real = createTransport(profile, limits);
    return {
      request: async (options) => {
        if (matches(options.method, options.path)) {
          held = true;
          await gate;
        }
        return real.request(options);
      },
      stream: (options, consume) => real.stream(options, consume),
      close: () => {
        real.close();
      },
    };
  };
  return {
    create,
    release: () => {
      release();
    },
    isHeld: () => held,
  };
}

describe('служба прохода: обрыв и досканирование', () => {
  it('AE5: обрыв на 18-м листе, досканирование — тридцать страниц по порядку', async () => {
    const { emulator, root, service } = await setup({
      sheets: 30,
      fault: { sheet: 18, kind: 'gone' },
    });

    const first = unwrap(await service.startPass(null));
    expect(first).toEqual({
      end: 'interrupted',
      pages: 17,
      error: { code: 'scanFeedFailed', details: { reason: 'gone' } },
    });
    expect(service.snapshot()).toMatchObject({ canResume: true, canAccept: true });
    emulator.clearJam();

    const second = unwrap(await service.startPass(null));

    expect(second).toEqual({ end: 'completed', pages: 13, error: null });
    const snapshot = service.snapshot();
    expect(snapshot.session?.passes.map((pass) => pass.state)).toEqual(['completed']);
    await expectPagesEqualFixtures(root, snapshot, 30);
    expect(pageKeys(snapshot).slice(16, 19)).toEqual([
      'p01-s01-0017',
      'p01-s02-0001',
      'p01-s02-0002',
    ]);
  });

  it('досканирование показывает в снимке признак и счётчик только своих страниц', async () => {
    const { emulator, service, snapshots } = await setup({
      sheets: 5,
      fault: { sheet: 3, kind: 'gone' },
    });
    unwrap(await service.startPass(null));
    emulator.clearJam();
    snapshots.length = 0;

    unwrap(await service.startPass(null));

    const progress = snapshots.map((it) => it.pass).filter((it) => it !== null);
    expect(progress.every((it) => it.resumed)).toBe(true);
    expect(Math.max(...progress.map((it) => it.pages))).toBe(3);
  });

  it('AE4: «Остановить» при досканировании — страницы первого сегмента целы, проход прерван', async () => {
    const { emulator, root, service } = await setup({
      sheets: 5,
      fault: { sheet: 3, kind: 'gone' },
    });
    unwrap(await service.startPass(null));
    emulator.load({ sheets: 3, fault: { sheet: 2, kind: 'stall' } });

    const resumed = service.startPass(null);
    // Две страницы первого сегмента, одна — досканирования, и ещё одна начата и молчит.
    await until(
      () => emulator.requests().filter((it) => it.endsWith('NextDocument 200')).length === 4,
    );
    unwrap(await service.stopPass());
    const report = unwrap(await resumed);

    expect(report).toEqual({ end: 'stopped', pages: 0, error: null });
    expect(service.snapshot().session?.passes[0]?.state).toBe('interrupted');
    expect(pageKeys(service.snapshot())).toEqual(['p01-s01-0001', 'p01-s01-0002']);
    expect(await pageFiles(root)).toEqual(['p01-s01-0001.jpg', 'p01-s01-0002.jpg']);
  });

  it('«Остановить» при досканировании и новое досканирование — номера сегментов не повторяются', async () => {
    const { emulator, root, service } = await setup({
      sheets: 5,
      fault: { sheet: 3, kind: 'gone' },
    });
    unwrap(await service.startPass(null));
    emulator.load({ sheets: 3, fault: { sheet: 2, kind: 'stall' } });
    const resumed = service.startPass(null);
    await until(
      () => emulator.requests().filter((it) => it.endsWith('NextDocument 200')).length === 4,
    );
    unwrap(await service.stopPass());
    unwrap(await resumed);
    emulator.load({ sheets: 3 });

    const again = unwrap(await service.startPass(null));

    expect(again).toEqual({ end: 'completed', pages: 3, error: null });
    expect(pageKeys(service.snapshot())).toEqual([
      'p01-s01-0001',
      'p01-s01-0002',
      'p01-s03-0001',
      'p01-s03-0002',
      'p01-s03-0003',
    ]);
    expect(await pageFiles(root)).toEqual([
      'p01-s01-0001.jpg',
      'p01-s01-0002.jpg',
      'p01-s03-0001.jpg',
      'p01-s03-0002.jpg',
      'p01-s03-0003.jpg',
    ]);
  });

  it('второй обрыв при досканировании — третьего сегмента нет, выбор тот же', async () => {
    const { emulator, service } = await setup({ sheets: 5, fault: { sheet: 3, kind: 'gone' } });
    unwrap(await service.startPass(null));
    emulator.load({ sheets: 3, fault: { sheet: 2, kind: 'gone' } });

    const second = unwrap(await service.startPass(null));

    expect(second).toMatchObject({ end: 'interrupted', pages: 1 });
    const snapshot = service.snapshot();
    expect(snapshot.session?.passes[0]?.state).toBe('interrupted');
    expect(snapshot).toMatchObject({ canResume: true, canAccept: true });
    expect(pageKeys(snapshot)).toEqual(['p01-s01-0001', 'p01-s01-0002', 'p01-s02-0001']);
  });

  it('«оставить как есть»: проход принят, досканировать больше нельзя', async () => {
    const { emulator, service } = await setup({ sheets: 5, fault: { sheet: 3, kind: 'gone' } });
    unwrap(await service.startPass(null));
    emulator.clearJam();

    unwrap(await service.acceptPass());

    const snapshot = service.snapshot();
    expect(snapshot.session?.passes[0]?.state).toBe('accepted');
    expect(snapshot).toMatchObject({ canResume: false, canAccept: false });
    // С M2 (U3) поверх принятого прохода начинается НОВЫЙ проход — оборотов, не досканирование.
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 3 });
    expect(service.snapshot().session?.passes.map((pass) => [pass.number, pass.state])).toEqual([
      [1, 'accepted'],
      [2, 'completed'],
    ]);
  });

  it('AE2: процесс убит посреди прохода — страницы на месте, проход прерван, повторно — то же', async () => {
    const emulator = await startTestEmulator({ scenario: { sheets: 20 } });
    const root = await makeTempDataRoot();
    // «Убить процесс»: после переименования 17-й страницы диск для службы перестаёт существовать.
    let dead = false;
    const { fs } = interceptFs<StorageFs>(realStorageFs, (call) => {
      if (dead) {
        throw fsError('EIO');
      }
      if (call.op === 'rename' && (call.to ?? '').endsWith('p01-s01-0017.jpg')) {
        dead = true;
      }
    });
    const connected = await connectTo(emulator);
    const killed = await open(root, connected, { fs });
    await killed.service.startPass(null);

    const first = await open(root, connected);
    const afterFirst = await journalOnDisk(root);
    const second = await first.restart();

    for (const harness of [first, second]) {
      const snapshot = harness.service.snapshot();
      expect(snapshot.session?.passes[0]?.state).toBe('interrupted');
      expect(snapshot.session?.passes[0]?.pages).toHaveLength(17);
      expect(snapshot.canResume).toBe(true);
    }
    expect(await pageFiles(root)).toHaveLength(17);
    // Повторная сверка ничего не меняет.
    expect(await journalOnDisk(root)).toEqual(afterFirst);
  });

  it('сбой записи журнала на странице и на исходе: повтор доводит журнал до DELETE (KTD-17)', async () => {
    const emulator = await startTestEmulator({
      scenario: { sheets: 30, fault: { sheet: 18, kind: 'gone' } },
    });
    const root = await makeTempDataRoot();
    const { journalFile } = layoutOf(root);
    let armed = false;
    let failures = 0;
    // `EIO` не повторяется помощником записи: один отказ — одна запись журнала. Падают запись
    // после 17-й страницы и запись исхода сегмента; третья запись — повтор службы — проходит.
    const { fs } = interceptFs<StorageFs>(realStorageFs, (call) => {
      if (call.op === 'rename' && (call.to ?? '').endsWith('p01-s01-0017.jpg')) {
        armed = true;
      }
      if (armed && failures < 2 && call.op === 'rename' && call.to === journalFile) {
        failures += 1;
        throw fsError('EIO');
      }
    });
    const { service } = await open(root, await connectTo(emulator), { fs });

    const report = unwrap(await service.startPass(null));

    expect(report).toMatchObject({ end: 'interrupted', pages: 17 });
    expect(failures).toBe(2);
    expect(service.snapshot().storage.unsaved).toBe(false);
    const journal = JSON.stringify(await journalOnDisk(root));
    expect(journal).toContain('"state":"interrupted"');
    expect(journal).toContain('"pageCount":17');
  });

  it('сбой между переименованием страницы и журналом, перезапуск, досканирование — 30 по порядку', async () => {
    const emulator = await startTestEmulator({
      scenario: { sheets: 30, fault: { sheet: 18, kind: 'gone' } },
    });
    const root = await makeTempDataRoot();
    const { journalFile } = layoutOf(root);
    let pagesRenamed = 0;
    const { fs } = interceptFs<StorageFs>(realStorageFs, (call) => {
      if (call.op === 'rename' && (call.to ?? '').endsWith('p01-s01-0017.jpg')) {
        pagesRenamed += 1;
      }
      if (pagesRenamed > 0 && call.op === 'rename' && call.to === journalFile) {
        throw fsError('EACCES');
      }
    });
    const connected = await connectTo(emulator);
    const crashed = await open(root, connected, { fs });
    const first = unwrap(await crashed.service.startPass(null));
    expect(first).toMatchObject({ end: 'interrupted', pages: 17 });
    expect(crashed.service.snapshot().storage.unsaved).toBe(true);
    expect(JSON.stringify(await journalOnDisk(root))).toContain('"pageCount":16');

    const restarted = await open(root, connected);
    expect(restarted.service.snapshot().session?.passes[0]?.pages).toHaveLength(17);
    emulator.clearJam();
    const second = unwrap(await restarted.service.startPass(null));

    expect(second).toEqual({ end: 'completed', pages: 13, error: null });
    await expectPagesEqualFixtures(root, restarted.service.snapshot(), 30);
  });

  it('ошибка записи страницы — проход прерван, номер последней целой страницы в снимке', async () => {
    const emulator = await startTestEmulator({ scenario: { sheets: 5 } });
    const root = await makeTempDataRoot();
    const { fs } = interceptFs<StorageFs>(realStorageFs, (call) => {
      if (call.op === 'rename' && (call.to ?? '').endsWith('p01-s01-0003.jpg')) {
        throw fsError('ENOSPC');
      }
    });
    const harness = await open(root, await connectTo(emulator), { fs });

    const report = unwrap(await harness.service.startPass(null));

    expect(report).toEqual({ end: 'interrupted', pages: 2, error: { code: 'storageFull' } });
    const snapshot = harness.service.snapshot();
    expect(snapshot.session?.passes[0]?.pages.at(-1)?.number).toBe(2);
    expect(await pageFiles(root)).toEqual(['p01-s01-0001.jpg', 'p01-s01-0002.jpg']);
    expect(emulator.requests().at(-1)).toBe('DELETE /eSCL/ScanJobs/<job> 200');
  });

  it('обрыв на первой странице нового прохода — отказ кодом, ни страниц, ни сессии', async () => {
    const { root, service } = await setup({ fault: { sheet: 1, kind: 'reset-before-headers' } });

    const result = await service.startPass(null);

    expect(errorOf(result)?.code).toBe('scannerUnreachable');
    expect(service.snapshot().session).toBeNull();
    expect(await pageFiles(root)).toEqual([]);
  });

  it('негодный Location — задание закрыто по статусу, проход не состоялся', async () => {
    const { emulator, service } = await setup({ sheets: 2, location: 'missing' });

    const result = await service.startPass(null);

    expect(errorOf(result)).toEqual({
      code: 'scannerBadResponse',
      details: { reason: 'location' },
    });
    expect(emulator.jobs()[0]?.state).toBe('Canceled');
    expect(service.snapshot().session).toBeNull();
  });

  it('процесс убит после 404 до закрытия задания — проход «завершён» на диске', async () => {
    const { emulator, root, service } = await setup({ sheets: 2, deleteHangs: true });

    const running = service.startPass(null);
    await until(() => emulator.requests().at(-1)?.startsWith('DELETE') === true);
    const journal = JSON.stringify(await journalOnDisk(root));
    unwrap(await running);

    expect(journal).toContain('"state":"completed"');
  });

  it('досканирование на другом устройстве отклоняется кодом', async () => {
    const { emulator, service } = await setup({ sheets: 5, fault: { sheet: 3, kind: 'gone' } });
    unwrap(await service.startPass(null));
    const other = await startTestEmulator({ scenario: { sheets: 3 } });
    await service.useScanner(await connectTo(other));

    const result = await service.startPass(null);

    expect(errorOf(result)).toEqual({
      code: 'sessionConflict',
      details: { reason: 'otherScanner' },
    });
    expect(service.snapshot().canResume).toBe(false);
    expect(other.jobs()).toEqual([]);
    expect(emulator.jobs()).toHaveLength(1);
  });

  it('досканирование на пересобранном журнале отклоняется кодом', async () => {
    const { root, service, restart } = await setup({
      sheets: 5,
      fault: { sheet: 3, kind: 'gone' },
    });
    unwrap(await service.startPass(null));
    await writeFile(layoutOf(root).journalFile, 'не json');

    const rebuilt = await restart();

    expect(rebuilt.service.snapshot().notices).toContain('journalRebuilt');
    expect(rebuilt.service.snapshot().session?.passes[0]?.paramsKnown).toBe(false);
    expect(errorOf(await rebuilt.service.startPass(null))).toEqual({
      code: 'sessionConflict',
      details: { reason: 'paramsUnknown' },
    });
  });
});

describe('служба прохода: «Остановить» в пограничные моменты', () => {
  it('«Остановить», пока POST ждёт ответа: фаза не возвращается со «stopping»', async () => {
    const emulator = await startTestEmulator({ scenario: { sheets: 3 } });
    const root = await makeTempDataRoot();
    const hold = holdingTransport(
      (method, path) => method === 'POST' && path.endsWith('/ScanJobs'),
    );
    const { service, snapshots } = await open(root, await connectTo(emulator), {
      connector: { createTransport: hold.create },
    });

    const running = service.startPass(null);
    await until(hold.isHeld);
    const stopped = service.stopPass();
    hold.release();
    const report = unwrap(await running);
    unwrap(await stopped);

    expect(report.end).toBe('stopped');
    const phases = snapshots.map((it) => it.pass?.phase ?? null);
    const stopAt = phases.indexOf('stopping');
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(phases.slice(stopAt).filter((it) => it !== null && it !== 'stopping')).toEqual([]);
    expect(emulator.requests().at(-1)?.startsWith('DELETE /eSCL/ScanJobs/<job>')).toBe(true);
    expect(service.snapshot().session).toBeNull();
  });

  it('«Остановить», пока закрываются незакрытые задания молчащего сканера, — без ожидания каждого', async () => {
    const { emulator, service } = await setup(
      { sheets: 2, deleteHangs: true },
      { jobLimits: { ...FAST, deleteDeadlineMs: 400 } },
    );
    const deletes = (): number =>
      emulator.requests().filter((it) => it.startsWith('DELETE')).length;
    // Два незакрытых задания: DELETE каждого молчит до срока.
    unwrap(await service.startPass(null));
    unwrap(await service.closeSession());
    emulator.load({ sheets: 2, deleteHangs: true });
    unwrap(await service.startPass(null));
    unwrap(await service.closeSession());
    emulator.load({ sheets: 2, deleteHangs: true });
    const before = deletes();
    const requestsBefore = emulator.requests().length;

    const running = service.startPass(null);
    await until(() => deletes() > before);
    const started = Date.now();
    unwrap(await service.stopPass());
    const report = unwrap(await running);

    expect(report.end).toBe('stopped');
    // Второе задание уже не закрывается: ждали не больше одного срока DELETE.
    expect(Date.now() - started).toBeLessThan(1500);
    expect(deletes()).toBe(before + 1);
    expect(
      emulator
        .requests()
        .slice(requestsBefore)
        .some((it) => it.startsWith('POST')),
    ).toBe(false);
  });
});

describe('служба прохода: проверка запомненного сканера', () => {
  it('сканер, подключённый во время проверки, не перезаписывается её результатом', async () => {
    const remembered = await startTestEmulator();
    const other = await startTestEmulator();
    const root = await makeTempDataRoot();
    const first = await open(root, await connectTo(remembered));
    expect(first.service.snapshot().scanner.kind).toBe('ready');

    const hold = holdingTransport(
      (method, path) => method === 'GET' && path.endsWith('/ScannerCapabilities'),
    );
    const service = await openPassService(root, {
      jobLimits: FAST,
      imageWorker: levelWorker,
      connector: { createTransport: hold.create },
      findByUuid: noSearch,
    });
    const checking = service.checkRememberedScanner();
    await until(hold.isHeld);
    expect(service.snapshot().scanner.kind).toBe('checking');
    unwrap(await service.useScanner(await connectTo(other)));
    hold.release();
    await checking;

    const { scanner } = service.snapshot();
    expect(scanner.kind).toBe('ready');
    expect(scanner.kind === 'ready' ? scanner.scanner.port : null).toBe(other.port);
  });

  it('проверка во время прохода и при рабочем подключении — ничего не делает', async () => {
    // Ревью сессии 9: проверка не трогает ни идущий проход, ни рабочее подключение —
    // второе обращение к занятому устройству увело бы слот в «не отвечает» посреди прохода.
    const { service, snapshots } = await setup({ sheets: 3, pageDelayMs: 150 });

    const pass = service.startPass(null);
    await until(() => snapshots.some((it) => it.pass?.phase === 'scanning'));
    await service.checkRememberedScanner();
    expect(service.snapshot().scanner.kind).toBe('ready');
    unwrap(await pass);
    expect(snapshots.every((it) => it.scanner.kind === 'ready')).toBe(true);

    // Вне прохода при «готов» — тоже no-op: неудачная проверка потеряла бы подключение.
    await service.checkRememberedScanner();
    expect(service.snapshot().scanner.kind).toBe('ready');
  });
});

describe('служба прохода: незакрытые задания', () => {
  it('незакрытое задание закрывается перед следующим стартом на том же сканере', async () => {
    const { emulator, root, service } = await setup({ sheets: 2, deleteHangs: true });
    unwrap(await service.startPass(null));
    const jobPath = emulator.jobs()[0]?.path;
    expect(await readFile(layoutOf(root).unclosedJobsFile, 'utf8')).toContain(jobPath);
    unwrap(await service.closeSession());
    emulator.load({ sheets: 2 });

    unwrap(await service.startPass(null));

    const requests = emulator.requests();
    const deleteAt = requests.findIndex((it) => it === 'DELETE /eSCL/ScanJobs/<job> 404');
    expect(deleteAt).toBeGreaterThan(0);
    expect(requests.indexOf('POST /eSCL/ScanJobs 201', deleteAt)).toBeGreaterThan(deleteAt);
    expect(await readFile(layoutOf(root).unclosedJobsFile, 'utf8')).not.toContain(jobPath);
  });

  it('незакрытое задание сканера A не порождает запроса к сканеру B', async () => {
    const { emulator, service } = await setup({ sheets: 2, deleteHangs: true });
    unwrap(await service.startPass(null));
    unwrap(await service.closeSession());
    const other = await startTestEmulator({ scenario: { sheets: 2 } });
    await service.useScanner(await connectTo(other));

    unwrap(await service.startPass(null));

    // До собственного задания к B не ушло ни одного `DELETE`; после — только закрытие своего.
    const posted = other.requests().indexOf('POST /eSCL/ScanJobs 201');
    expect(posted).toBeGreaterThan(0);
    expect(
      other
        .requests()
        .slice(0, posted)
        .some((it) => it.startsWith('DELETE')),
    ).toBe(false);
    expect(emulator.requests().filter((it) => it.startsWith('DELETE'))).toHaveLength(1);
  });
});

describe('служба прохода: закрытие окна', () => {
  it('прерывание по закрытию окна оставляет страницы и состояние «прерван»', async () => {
    const { emulator, root, service } = await setup({
      sheets: 5,
      fault: { sheet: 3, kind: 'stall' },
    });

    const running = service.startPass(null);
    await until(
      () => emulator.requests().filter((it) => it.endsWith('NextDocument 200')).length === 3,
    );
    await service.interrupt(2000);
    const report = unwrap(await running);

    expect(report).toEqual({ end: 'interrupted', pages: 2, error: { code: 'canceled' } });
    expect(service.snapshot().session?.passes[0]?.state).toBe('interrupted');
    expect(await pageFiles(root)).toEqual(['p01-s01-0001.jpg', 'p01-s01-0002.jpg']);
    expect(emulator.requests().at(-1)).toBe('DELETE /eSCL/ScanJobs/<job> 200');
  });

  it('прерывание возвращается не позже срока, даже если DELETE молчит', async () => {
    const { emulator, service } = await setup(
      { sheets: 5, fault: { sheet: 3, kind: 'stall' }, deleteHangs: true },
      { jobLimits: { ...FAST, deleteDeadlineMs: 1000 } },
    );

    const running = service.startPass(null);
    await until(
      () => emulator.requests().filter((it) => it.endsWith('NextDocument 200')).length === 3,
    );
    const started = Date.now();
    await service.interrupt(100);

    expect(Date.now() - started).toBeLessThan(800);
    expect(service.snapshot().session?.passes[0]?.state).toBe('interrupted');
    await running;
  });

  it('без идущего прохода прерывание ничего не делает', async () => {
    const { service } = await setup();
    await service.interrupt(10);
    expect(service.snapshot().pass).toBeNull();
  });
});
