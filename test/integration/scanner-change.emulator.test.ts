import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { fail, ok, type ConnectScannerOutcome, type Result } from '../../src/shared';
import { createCommands, type Commands } from '../../src/core/commands/handlers';
import {
  openPassService,
  type PassService,
  type PassServiceOptions,
} from '../../src/core/scan/pass-service';
import { layoutOf } from '../../src/core/storage/layout';
import { realStorageFs, type StorageFs } from '../../src/core/storage/storage-fs';
import type { Emulator } from '../emulator/server';
import { startTestEmulator } from '../support/emulator';
import { fsError, interceptFs } from '../support/intercept-fs';
import { levelWorker } from '../support/image-worker';
import { FAST_JOB_LIMITS } from '../support/pass-service';
import { unwrap } from '../support/result';
import { makeTempDataRoot } from '../support/temp-data-root';
import { noSearch } from '../support/uuid-search';

// Смена устройства на настоящей цепочке (B-29, U7): эмулятор по HTTPS → подключение через
// обработчики команд → служба и настройки во временном корне. Образец смены сертификата —
// перезапуск эмулятора на том же порту с новым сертификатом (как в `pass.emulator.test.ts`).

const OTHER_UUID = '99999999-8888-4777-8666-555555555555';

interface Harness {
  readonly root: string;
  readonly service: PassService;
  readonly handlers: Commands['handlers'];
  /** Та же служба заново над тем же корнем — «приложение запущено снова». */
  readonly restart: (options?: Partial<PassServiceOptions>) => Promise<Harness>;
}

async function open(root: string, options: Partial<PassServiceOptions> = {}): Promise<Harness> {
  const service = await openPassService(root, {
    jobLimits: FAST_JOB_LIMITS,
    imageWorker: levelWorker,
    minFreeBytes: 1,
    retry: { ceilingMs: 50 },
    findByUuid: noSearch,
    ...options,
  });
  const commands = createCommands({
    service,
    openDataFolder: () => Promise.resolve(ok(undefined)),
    openFolder: () => Promise.resolve(ok(undefined)),
    openProjectPage: () => Promise.resolve(ok(undefined)),
    defaultSaveFolder: root,
    askSaveFolder: () => Promise.resolve(null),
    folderExists: () => Promise.resolve(true),
    onDiscoveryChanged: () => undefined,
  });
  return {
    root,
    service,
    handlers: commands.handlers,
    restart: (next = {}) => {
      commands.dispose();
      return open(root, next);
    },
  };
}

/** Подключение по адресу эмулятора без схемы: как ввод хоста с портом в модалке. */
const connectTo = (harness: Harness, emulator: Emulator): Promise<Result<ConnectScannerOutcome>> =>
  harness.handlers.connectScanner({
    kind: 'address',
    host: `${emulator.host}:${emulator.port}`,
    scheme: null,
    port: null,
    basePath: null,
  });

function confirmationOf(result: Result<ConnectScannerOutcome>) {
  if (!result.ok || result.value.kind !== 'confirmation') {
    throw new Error(`ожидали подтверждение, получили ${JSON.stringify(result)}`);
  }
  return result.value;
}

const settingsOnDisk = async (root: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(layoutOf(root).settingsFile, 'utf8')) as Record<string, unknown>;

const rememberedOnDisk = async (root: string) =>
  (await settingsOnDisk(root)).scanner as {
    fingerprint: string | null;
    scheme: string;
    uuid: string;
  };

/** Первое подключение к эмулятору A: запомнен его отпечаток. */
async function connected(options: Partial<PassServiceOptions> = {}) {
  const first = await startTestEmulator({
    scenario: { sheets: 5, fault: { sheet: 3, kind: 'gone' } },
  });
  const root = await makeTempDataRoot();
  const harness = await open(root, options);
  const result = await connectTo(harness, first);
  expect(result).toEqual(
    ok({ kind: 'connected', scanner: expect.objectContaining({ scheme: 'https' }) as unknown }),
  );
  expect((await rememberedOnDisk(root)).fingerprint).toBe(first.fingerprint);
  return { first, root, harness };
}

/** Эмулятор A закрыт, на его порту отвечает B: новый сертификат, HTTP или другой UUID. */
async function replaced(
  first: Emulator,
  variant: 'newCert' | 'http' | 'otherUuid',
): Promise<Emulator> {
  await first.close();
  switch (variant) {
    case 'newCert':
      return startTestEmulator({ port: first.port, scenario: { sheets: 5 } });
    case 'http':
      return startTestEmulator({ port: first.port, http: true, scenario: { sheets: 5 } });
    case 'otherUuid':
      return startTestEmulator({
        port: first.port,
        ...(first.cert === null ? {} : { cert: first.cert }),
        uuid: OTHER_UUID,
        scenario: { sheets: 5 },
      });
  }
}

describe('смена устройства на эмуляторе', () => {
  it('первое подключение — без подтверждения, отпечаток записан', async () => {
    const { harness, first } = await connected();
    expect(harness.service.snapshot().scanner.kind).toBe('ready');
    expect(harness.service.rememberedScanner()?.fingerprint).toBe(first.fingerprint);
  });

  it('новый сертификат на том же адресе: подтверждение; отмена ничего не меняет; подтверждение записывает', async () => {
    const { first, root, harness } = await connected();
    const second = await replaced(first, 'newCert');
    expect(second.fingerprint).not.toBe(first.fingerprint);

    const confirmation = confirmationOf(await connectTo(harness, second));
    expect(confirmation.scanner.scheme).toBe('https');
    expect(confirmation.interruptedPass).toBe(false);
    // Слот и настройки не тронуты: на диске отпечаток A, в слоте — A.
    expect((await rememberedOnDisk(root)).fingerprint).toBe(first.fingerprint);
    expect(harness.service.rememberedScanner()?.fingerprint).toBe(first.fingerprint);

    // Отмена гасит пробу: токен больше не принимается, запись прежняя.
    unwrap(await harness.handlers.cancelConnect(undefined));
    expect(await harness.handlers.confirmScannerChange({ token: confirmation.token })).toEqual(
      fail('scannerChangeStale', { reason: 'token' }),
    );
    expect((await rememberedOnDisk(root)).fingerprint).toBe(first.fingerprint);

    // Повторная проба и подтверждение: отпечаток B на диске, сканер готов.
    const again = confirmationOf(await connectTo(harness, second));
    const confirmed = unwrap(await harness.handlers.confirmScannerChange({ token: again.token }));
    expect(confirmed.settingsSaved).toBe(true);
    expect(harness.service.snapshot().scanner.kind).toBe('ready');
    expect((await rememberedOnDisk(root)).fingerprint).toBe(second.fingerprint);

    // AE2: после перезапуска приложение подключается без вопроса.
    const restarted = await harness.restart();
    await restarted.service.checkRememberedScanner();
    expect(restarted.service.snapshot().scanner.kind).toBe('ready');
  }, 20_000);

  it('HTTP на том же адресе: подтверждение; после него запомнен HTTP без отпечатка', async () => {
    const { first, root, harness } = await connected();
    const second = await replaced(first, 'http');

    const confirmation = confirmationOf(await connectTo(harness, second));
    expect(confirmation.scanner.scheme).toBe('http');
    expect((await rememberedOnDisk(root)).fingerprint).toBe(first.fingerprint);

    unwrap(await harness.handlers.confirmScannerChange({ token: confirmation.token }));
    const remembered = await rememberedOnDisk(root);
    expect(remembered.scheme).toBe('http');
    expect(remembered.fingerprint).toBeNull();
  }, 20_000);

  it('другой UUID на том же адресе с тем же сертификатом — подтверждение', async () => {
    const { first, root, harness } = await connected();
    const second = await replaced(first, 'otherUuid');
    expect(second.fingerprint).toBe(first.fingerprint);

    const confirmation = confirmationOf(await connectTo(harness, second));
    expect((await rememberedOnDisk(root)).uuid).not.toBe(OTHER_UUID);
    unwrap(await harness.handlers.confirmScannerChange({ token: confirmation.token }));
    expect((await rememberedOnDisk(root)).uuid).toBe(OTHER_UUID);
  }, 20_000);

  it('отказ записи настроек: сканер в памяти, settingsSaved ложь, после перезапуска снова смена', async () => {
    const { first, root } = await connected();
    const { settingsFile } = layoutOf(root);
    const { fs } = interceptFs<StorageFs>(realStorageFs, (call) => {
      if (call.op === 'rename' && call.to === settingsFile) {
        throw fsError('EIO');
      }
    });
    const harness = await open(root, { fs });
    const second = await replaced(first, 'newCert');

    const confirmation = confirmationOf(await connectTo(harness, second));
    const confirmed = unwrap(
      await harness.handlers.confirmScannerChange({ token: confirmation.token }),
    );

    expect(confirmed.settingsSaved).toBe(false);
    expect(harness.service.snapshot().scanner.kind).toBe('ready');
    expect((await rememberedOnDisk(root)).fingerprint).toBe(first.fingerprint);

    const restarted = await harness.restart({ fs: realStorageFs });
    await restarted.service.checkRememberedScanner();
    expect(restarted.service.snapshot().scanner.kind).toBe('otherDevice');
    confirmationOf(await connectTo(restarted, second));
  }, 20_000);

  it('прерванный проход: после подтверждения нового сертификата досканировать нельзя, журнал и страницы целы', async () => {
    const { first, root, harness } = await connected();
    const report = unwrap(await harness.service.startPass(null));
    expect(report).toMatchObject({ end: 'interrupted', pages: 2 });
    expect(harness.service.snapshot().canResume).toBe(true);
    const { journalFile, pagesDir } = layoutOf(root);
    const journalBefore = await readFile(journalFile);
    const pagesBefore = (await readdir(pagesDir)).sort();

    const second = await replaced(first, 'newCert');
    const confirmation = confirmationOf(await connectTo(harness, second));
    expect(confirmation.interruptedPass).toBe(true);
    expect(confirmation.awaitingBacks).toBe(false);
    unwrap(await harness.handlers.confirmScannerChange({ token: confirmation.token }));

    const snapshot = harness.service.snapshot();
    expect(snapshot.scanner.kind).toBe('ready');
    expect(snapshot.canResume).toBe(false);
    expect(snapshot.session?.passes[0]?.pages).toHaveLength(2);
    expect((await readFile(journalFile)).equals(journalBefore)).toBe(true);
    expect((await readdir(pagesDir)).sort()).toEqual(pagesBefore);
    expect(await harness.service.startPass(null)).toEqual({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'otherScanner' } },
    });
  }, 30_000);

  it('прерванный проход: HTTP с тем же UUID после подтверждения тоже закрывает досканирование', async () => {
    const { first, harness } = await connected();
    unwrap(await harness.service.startPass(null));
    expect(harness.service.snapshot().canResume).toBe(true);

    const second = await replaced(first, 'http');
    const confirmation = confirmationOf(await connectTo(harness, second));
    expect(confirmation.interruptedPass).toBe(true);
    unwrap(await harness.handlers.confirmScannerChange({ token: confirmation.token }));

    expect(harness.service.snapshot().scanner.kind).toBe('ready');
    expect(harness.service.snapshot().canResume).toBe(false);
  }, 30_000);
});
