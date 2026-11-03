import { fail, ok, type Result, type Snapshot } from '@shared';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectedScanner, Connector } from '../escl/connect';
import type { PassService, UseScannerReport } from '../scan/pass-service';
import { scannerInfoOf, storedScannerOf, type StoredScanner } from '../storage/stored-scanner';
import { createCommands } from './handlers';

// Смена устройства в обработчиках (B-29, KTD-6, KTD-7): решение до `useScanner`, одна ожидающая
// проба с одноразовым токеном, подтверждение перечитывает настройки. Отпечатки синтетические.

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);
const UUID = '11111111-2222-4333-8444-555555555555';

const REMEMBERED: StoredScanner = {
  scheme: 'https',
  host: '192.0.2.10',
  port: 443,
  basePath: '/eSCL',
  fingerprint: FP_A,
  uuid: UUID,
  name: 'ScanPro 200',
};

const connectedWith = (fingerprint: string | null, uuid = UUID): ConnectedScanner =>
  ({
    profile: {
      scheme: fingerprint === null ? 'http' : 'https',
      host: '192.0.2.10',
      port: fingerprint === null ? 80 : 443,
      basePath: '/eSCL',
      fingerprint,
    },
    capabilities: { uuid, makeAndModel: 'ScanPro 300' },
    options: { colorModes: [], resolutions: [], paperSizes: [] },
  }) as unknown as ConnectedScanner;

const IDLE = { pass: null } as unknown as Snapshot;
const RUNNING = { pass: { phase: 'scanning' } } as unknown as Snapshot;

function setup({
  remembered = REMEMBERED,
  probe = connectedWith(FP_B),
  settingsSaved = true,
}: {
  remembered?: StoredScanner | null;
  probe?: ConnectedScanner;
  settingsSaved?: boolean;
} = {}) {
  let snapshot = IDLE;
  const service = {
    snapshot: vi.fn(() => snapshot),
    rememberedScanner: vi.fn((): StoredScanner | null => remembered),
    changeConsequences: vi.fn(() => ({ interruptedPass: true, awaitingBacks: false })),
    useScanner: vi.fn((): Promise<Result<UseScannerReport>> =>
      Promise.resolve(ok({ settingsSaved })),
    ),
    rememberedSaveFolder: vi.fn((): string | null => null),
    checkRememberedScanner: vi.fn(() => Promise.resolve()),
  };
  const connect = vi.fn(() => Promise.resolve(ok(probe)));
  const cancel = vi.fn();
  const connector: Connector = { connect, cancel };
  const commands = createCommands({
    service: service as unknown as PassService,
    openDataFolder: () => Promise.resolve(ok(undefined)),
    openFolder: () => Promise.resolve(ok(undefined)),
    openProjectPage: () => Promise.resolve(ok(undefined)),
    defaultSaveFolder: 'C:\\Users\\Документы',
    askSaveFolder: () => Promise.resolve(null),
    folderExists: () => Promise.resolve(true),
    onDiscoveryChanged: () => undefined,
    connector,
  });
  const connectByAddress = () =>
    commands.handlers.connectScanner({
      kind: 'address',
      host: '192.0.2.10',
      scheme: null,
      port: null,
      basePath: null,
    });
  const rememberedChanged = (next: StoredScanner | null): void => {
    service.rememberedScanner.mockReturnValue(next);
  };
  const passStarted = (): void => {
    snapshot = RUNNING;
  };
  return {
    ...commands,
    service,
    connect,
    cancel,
    connectByAddress,
    rememberedChanged,
    passStarted,
  };
}

function confirmationOf(result: Awaited<ReturnType<ReturnType<typeof setup>['connectByAddress']>>) {
  if (!result.ok || result.value.kind !== 'confirmation') {
    throw new Error(`ожидали подтверждение, получили ${JSON.stringify(result)}`);
  }
  return result.value;
}

describe('connectScanner — решение о смене устройства', () => {
  it('другой сертификат на адресе запомненного: слот не тронут, ответ несёт токен без отпечатка', async () => {
    const { connectByAddress, service } = setup();

    const result = await connectByAddress();

    const confirmation = confirmationOf(result);
    expect(service.useScanner).not.toHaveBeenCalled();
    expect(confirmation).toEqual({
      kind: 'confirmation',
      token: expect.stringMatching(/^[0-9a-f]{32}$/) as string,
      scanner: scannerInfoOf(storedScannerOf(connectedWith(FP_B))),
      remembered: scannerInfoOf(REMEMBERED),
      interruptedPass: true,
      awaitingBacks: false,
    });
    expect(JSON.stringify(confirmation)).not.toContain(FP_A);
    expect(JSON.stringify(confirmation)).not.toContain(FP_B);
  });

  it('HTTP на адресе запомненного с отпечатком — тоже подтверждение', async () => {
    const { connectByAddress, service } = setup({ probe: connectedWith(null) });

    confirmationOf(await connectByAddress());

    expect(service.useScanner).not.toHaveBeenCalled();
  });

  it('первое подключение и тот же отпечаток идут без подтверждения', async () => {
    const first = setup({ remembered: null });
    expect(await first.connectByAddress()).toEqual(
      ok({ kind: 'connected', scanner: scannerInfoOf(storedScannerOf(connectedWith(FP_B))) }),
    );
    expect(first.service.useScanner).toHaveBeenCalledOnce();

    const same = setup({ probe: connectedWith(FP_A) });
    expect((await same.connectByAddress()).ok && true).toBe(true);
    expect(same.service.useScanner).toHaveBeenCalledOnce();
  });
});

describe('confirmScannerChange', () => {
  it('подтверждение по токену: useScanner, запись, итог с settingsSaved; повтор — отказ', async () => {
    const { connectByAddress, handlers, service } = setup();
    const { token } = confirmationOf(await connectByAddress());

    const confirmed = await handlers.confirmScannerChange({ token });

    expect(confirmed).toEqual(
      ok({ scanner: scannerInfoOf(storedScannerOf(connectedWith(FP_B))), settingsSaved: true }),
    );
    expect(service.useScanner).toHaveBeenCalledExactlyOnceWith(connectedWith(FP_B));
    expect(await handlers.confirmScannerChange({ token })).toEqual(
      fail('scannerChangeStale', { reason: 'token' }),
    );
  });

  it('чужой токен, токен без пробы и негодный вход — отказ без useScanner', async () => {
    const { connectByAddress, handlers, service } = setup();
    expect(await handlers.confirmScannerChange({ token: 'ab'.repeat(16) })).toEqual(
      fail('scannerChangeStale', { reason: 'token' }),
    );
    confirmationOf(await connectByAddress());

    expect(await handlers.confirmScannerChange({ token: 'ab'.repeat(16) })).toEqual(
      fail('scannerChangeStale', { reason: 'token' }),
    );
    for (const garbage of [undefined, null, {}, { token: '' }, { token: 'XYZ' }, { token: 1 }]) {
      const result = await handlers.confirmScannerChange(garbage);
      expect(result.ok, JSON.stringify(garbage)).toBe(false);
      expect(!result.ok && result.error.code).toBe('invalidInput');
    }
    expect(service.useScanner).not.toHaveBeenCalled();
  });

  it('новая проба заменяет токен; отмена и выход гасят его', async () => {
    const current = setup();
    const { connectByAddress, handlers, service } = current;
    const first = confirmationOf(await connectByAddress());
    const second = confirmationOf(await connectByAddress());
    expect(second.token).not.toBe(first.token);
    expect(await handlers.confirmScannerChange({ token: first.token })).toEqual(
      fail('scannerChangeStale', { reason: 'token' }),
    );

    const third = confirmationOf(await connectByAddress());
    await handlers.cancelConnect(undefined);
    expect(await handlers.confirmScannerChange({ token: third.token })).toEqual(
      fail('scannerChangeStale', { reason: 'token' }),
    );

    const fourth = confirmationOf(await connectByAddress());
    current.dispose();
    expect(await handlers.confirmScannerChange({ token: fourth.token })).toEqual(
      fail('scannerChangeStale', { reason: 'token' }),
    );
    expect(service.useScanner).not.toHaveBeenCalled();
  });

  it('настройки изменились между пробой и подтверждением — отказ, запись не перетёрта', async () => {
    const { connectByAddress, handlers, service, rememberedChanged } = setup();
    const { token } = confirmationOf(await connectByAddress());
    rememberedChanged({ ...REMEMBERED, host: '192.0.2.77' });

    expect(await handlers.confirmScannerChange({ token })).toEqual(
      fail('scannerChangeStale', { reason: 'settings' }),
    );
    expect(service.useScanner).not.toHaveBeenCalled();

    const again = setup();
    const next = confirmationOf(await again.connectByAddress());
    again.rememberedChanged(null);
    expect(await again.handlers.confirmScannerChange({ token: next.token })).toEqual(
      fail('scannerChangeStale', { reason: 'settings' }),
    );
  });

  it('идущий проход отклоняет подтверждение', async () => {
    const { connectByAddress, handlers, service, passStarted } = setup();
    const { token } = confirmationOf(await connectByAddress());
    passStarted();

    expect(await handlers.confirmScannerChange({ token })).toEqual({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'passRunning' } },
    });
    expect(service.useScanner).not.toHaveBeenCalled();
  });

  it('отказ записи настроек — не отказ: сканер в слоте, settingsSaved ложь', async () => {
    const { connectByAddress, handlers } = setup({ settingsSaved: false });
    const { token } = confirmationOf(await connectByAddress());

    expect(await handlers.confirmScannerChange({ token })).toEqual(
      ok({ scanner: scannerInfoOf(storedScannerOf(connectedWith(FP_B))), settingsSaved: false }),
    );
  });
});
