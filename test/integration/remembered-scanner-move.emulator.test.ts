import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { UuidSearchEnd, UuidSearchOptions } from '../../src/core/discovery/find-by-uuid';
import { probeScanner, type ConnectedScanner } from '../../src/core/escl/connect';
import type { ScanJobLimits } from '../../src/core/escl/scan-job';
import { openPassService, type PassService } from '../../src/core/scan/pass-service';
import { layoutOf } from '../../src/core/storage/layout';
import type { StartUuidSearch } from '../../src/core/storage/remembered-search';
import type { Emulator } from '../emulator/server';
import { startTestEmulator } from '../support/emulator';
import { unwrap } from '../support/result';
import { makeTempDataRoot } from '../support/temp-data-root';
import { until } from '../support/until';

// Переезд запомненного сканера сквозь настоящий транспорт (M5, U5): эмулятор на порту A
// запомнен, затем закрыт и поднят на порту B — с тем же сертификатом (тот же сканер на новом
// адресе) или с новым (чужой с тем же UUID: UUID эмулятора один — из фикстуры capabilities).
// Поиск по UUID — подставной, без сокетов 5353 (KTD9): он объявляет порт B. Закрытый порт A
// отказывает в соединении сразу, поэтому поиск стартует без порога 1,5 с и тесты идут быстро.

// Те же правила, что в продукте, но время прохода сжато (как в pass.emulator).
const FAST: Partial<ScanJobLimits> = {
  retryDelayMs: 5,
  busyCeilingMs: 200,
  notReadyCeilingMs: 2000,
  pageIdleTimeoutMs: 300,
  pageDeadlineMs: 3000,
  deleteDeadlineMs: 300,
};

async function connectTo(emulator: Emulator): Promise<ConnectedScanner> {
  return unwrap(await probeScanner({ ...emulator, fingerprint: null }));
}

/**
 * Поиск, объявляющий эмулятор на `127.0.0.1` и сразу заканчивающийся: объявлять больше нечего.
 * `hold` придерживает объявление до сигнала теста; `starts` считает запуски поиска.
 */
function announcing(port: () => number, hold: Promise<void> = Promise.resolve()) {
  const starts: UuidSearchOptions[] = [];
  const start: StartUuidSearch = (options) => {
    starts.push(options);
    let finish!: (end: UuidSearchEnd) => void;
    const done = new Promise<UuidSearchEnd>((resolve) => {
      finish = resolve;
    });
    options.signal?.addEventListener('abort', () => {
      finish('canceled');
    });
    // Кандидат приходит не раньше, чем вызывающий получил объект поиска (контракт findByUuid).
    void hold.then(() => {
      if (options.signal?.aborted !== true) {
        options.onCandidate({ address: '127.0.0.1', port: port(), basePath: '/eSCL' });
      }
      finish('window');
    });
    return {
      done,
      stop: () => {
        finish('stopped');
      },
    };
  };
  return { start, starts };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** Служба на корне без подключения — «приложение запущено», проверку зовёт тест (как main). */
function launch(root: string, findByUuid: StartUuidSearch): Promise<PassService> {
  return openPassService(root, {
    jobLimits: FAST,
    minFreeBytes: 1,
    retry: { ceilingMs: 50 },
    findByUuid,
  });
}

/** Первый запуск: эмулятор подключён пользователем и запомнен в `settings.json`. */
async function remember(root: string, emulator: Emulator): Promise<PassService> {
  const service = await launch(root, announcing(() => 0).start);
  unwrap(await service.useScanner(await connectTo(emulator)));
  return service;
}

const settingsBytes = (root: string): Promise<Buffer> => readFile(layoutOf(root).settingsFile);

async function settingsScanner(root: string): Promise<unknown> {
  const parsed = JSON.parse((await settingsBytes(root)).toString('utf8')) as {
    scanner: unknown;
  };
  return parsed.scanner;
}

const capabilityRequests = (emulator: Emulator): number =>
  emulator.requests().filter((it) => it.startsWith('GET /eSCL/ScannerCapabilities')).length;

/** Тот же сертификат на новом порту — тот же сканер переехал. */
async function moved(from: Emulator, scenario = {}): Promise<Emulator> {
  const cert = from.cert;
  if (cert === null) {
    throw new Error('переезд — только у эмулятора на HTTPS');
  }
  await from.close();
  return startTestEmulator({ cert, scenario });
}

describe('запомненный сканер переехал: проверка при запуске', () => {
  it('AE1: тот же сертификат на новом порту — «готов», порт B в settings.json, следующий запуск без поиска', async () => {
    const root = await makeTempDataRoot();
    const a = await startTestEmulator();
    await remember(root, a);
    const portA = a.port;
    const b = await moved(a);
    expect(b.port).not.toBe(portA);
    expect(b.fingerprint).toBe(a.fingerprint);

    const search = announcing(() => b.port);
    const service = await launch(root, search.start);
    await service.checkRememberedScanner();

    const { scanner } = service.snapshot();
    expect(scanner.kind).toBe('ready');
    expect(scanner.kind === 'ready' ? scanner.scanner.port : null).toBe(b.port);
    expect(search.starts).toHaveLength(1);
    expect(search.starts[0]?.uuid).toBeTruthy();
    // Перечитано с диска: запись атомарная, формат прежний (R13).
    expect(await settingsScanner(root)).toMatchObject({
      scheme: 'https',
      host: '127.0.0.1',
      port: b.port,
      fingerprint: a.fingerprint,
    });

    const again = announcing(() => b.port);
    const next = await launch(root, again.start);
    const before = capabilityRequests(b);
    await next.checkRememberedScanner();

    expect(next.snapshot().scanner.kind).toBe('ready');
    expect(again.starts).toHaveLength(0);
    expect(capabilityRequests(b)).toBe(before + 1);
  });

  it('AE2: тот же UUID, другой сертификат на новом порту — «другое устройство», settings.json прежний', async () => {
    const root = await makeTempDataRoot();
    const a = await startTestEmulator();
    await remember(root, a);
    const portA = a.port;
    await a.close();
    const stranger = await startTestEmulator();
    expect(stranger.fingerprint).not.toBe(a.fingerprint);
    const before = await settingsBytes(root);

    const search = announcing(() => stranger.port);
    const service = await launch(root, search.start);
    await service.checkRememberedScanner();

    const { scanner } = service.snapshot();
    expect(scanner.kind).toBe('otherDevice');
    // Строка показывает запомненный сканер, как до M5 (R7).
    expect(scanner.kind === 'otherDevice' ? scanner.scanner.port : null).toBe(portA);
    expect(search.starts).toHaveLength(1);
    // Старый порт отказал в соединении — «чужой» мог прийти только от кандидата: его отклонил
    // отпечаток в TLS, до HTTP-запроса.
    expect(scanner.kind === 'otherDevice' ? scanner.error?.code : null).toBe(
      'scannerCertificateChanged',
    );
    expect(capabilityRequests(stranger)).toBe(0);
    expect((await settingsBytes(root)).equals(before)).toBe(true);
  });

  it('AE8: прерванный проход снят на A — после переезда досканирование и закрытие задания идут на B', async () => {
    const root = await makeTempDataRoot();
    // Обрыв подачи на третьем листе; DELETE молчит — задание остаётся незакрытым.
    const a = await startTestEmulator({
      scenario: { sheets: 5, fault: { sheet: 3, kind: 'gone' }, deleteHangs: true },
    });
    const first = await remember(root, a);
    expect(unwrap(await first.startPass(null))).toMatchObject({ end: 'interrupted', pages: 2 });
    const jobPath = a.jobs()[0]?.path ?? '';
    expect(jobPath).not.toBe('');
    const { journalFile, unclosedJobsFile } = layoutOf(root);
    expect(await readFile(unclosedJobsFile, 'utf8')).toContain(jobPath);
    const journalBefore = await readFile(journalFile);
    const unclosedBefore = await readFile(unclosedJobsFile);
    const b = await moved(a, { sheets: 3 });

    const service = await launch(root, announcing(() => b.port).start);
    await service.checkRememberedScanner();

    expect(service.snapshot().scanner.kind).toBe('ready');
    expect(service.snapshot()).toMatchObject({ canResume: true });
    // Переезд не переписывает ни журнал, ни файл незакрытых заданий (R12, KTD7).
    expect((await readFile(journalFile)).equals(journalBefore)).toBe(true);
    expect((await readFile(unclosedJobsFile)).equals(unclosedBefore)).toBe(true);

    const report = unwrap(await service.startPass(null));

    expect(report).toEqual({ end: 'completed', pages: 3, error: null });
    expect(service.snapshot().session?.passes.map((pass) => pass.state)).toEqual(['completed']);
    expect(service.snapshot().session?.passes[0]?.pages).toHaveLength(5);
    // Незакрытое задание A закрыто запросом на B — до нового задания.
    const requests = b.requests();
    const deleteAt = requests.indexOf('DELETE /eSCL/ScanJobs/<job> 404');
    expect(deleteAt).toBeGreaterThan(0);
    expect(requests.indexOf('POST /eSCL/ScanJobs 201')).toBeGreaterThan(deleteAt);
    expect(b.exchanges.some((it) => it.method === 'DELETE' && it.path === jobPath)).toBe(true);
    expect(await readFile(unclosedJobsFile, 'utf8')).not.toContain(jobPath);
  });

  it('AE6: capabilities дважды «занят» на запомненном адресе — «готов» без поиска', async () => {
    const root = await makeTempDataRoot();
    const a = await startTestEmulator();
    await remember(root, a);
    a.load({ busyCapabilities: 2 });
    const before = await settingsBytes(root);

    const search = announcing(() => a.port);
    const service = await launch(root, search.start);
    await service.checkRememberedScanner();

    expect(service.snapshot().scanner.kind).toBe('ready');
    expect(search.starts).toHaveLength(0);
    expect(
      a
        .requests()
        .filter((it) => it.startsWith('GET /eSCL/ScannerCapabilities'))
        .slice(-3),
    ).toEqual([
      'GET /eSCL/ScannerCapabilities 503',
      'GET /eSCL/ScannerCapabilities 503',
      'GET /eSCL/ScannerCapabilities 200',
    ]);
    expect((await settingsBytes(root)).equals(before)).toBe(true);
  });

  it('AE4: сканер, подключённый вручную во время поиска, остаётся в слоте и в settings.json', async () => {
    const root = await makeTempDataRoot();
    const a = await startTestEmulator();
    await remember(root, a);
    const b = await moved(a);
    const other = await startTestEmulator();
    const release = gate();

    const search = announcing(() => b.port, release.opened);
    const service = await launch(root, search.start);
    const checking = service.checkRememberedScanner();
    await until(() => search.starts.length === 1);
    expect(service.snapshot().scanner.kind).toBe('checking');
    unwrap(await service.useScanner(await connectTo(other)));
    release.open();
    await checking;

    // Поиск нашёл переехавший запомненный, но выбор пользователя не перезаписан (R8).
    expect(capabilityRequests(b)).toBe(1);
    const { scanner } = service.snapshot();
    expect(scanner.kind).toBe('ready');
    expect(scanner.kind === 'ready' ? scanner.scanner.port : null).toBe(other.port);
    expect(await settingsScanner(root)).toMatchObject({
      port: other.port,
      fingerprint: other.fingerprint,
    });
  });
});
