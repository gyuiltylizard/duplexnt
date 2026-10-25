import { describe, expect, it } from 'vitest';
import { fail, ok, type Result, type ScanParams } from '@shared';
import { ET_3850, readFixture, readFixtureText } from '../../../test/support/fixtures';
import { parseCapabilities } from '../escl/capabilities';
import type { ConnectedScanner } from '../escl/connect';
import { DEFAULT_SCAN_PARAMS, scanOptionsOf } from '../escl/scan-settings';
import type { BufferedResponse, ScannerTransport } from '../escl/transport';
import type { Settings, SettingsStore } from '../storage/settings-store';
import { scannerInfoOf, storedScannerOf, type StoredScanner } from '../storage/stored-scanner';
import { createScannerSlot } from './scanner-slot';

// Слот сканера напрямую (M5, U4): исходы проверки запомненного, гонка с ручным подключением,
// сканер для снимка в каждом состоянии. Через службу и эмулятор — pass-service.test.ts и
// test/integration/pass.emulator.test.ts.

const CAPABILITIES = readFixtureText(...ET_3850, 'ScannerCapabilities.xml');
const FINGERPRINT = 'ab'.repeat(32);
const PARAMS: ScanParams = { colorMode: 'RGB24', resolution: 600, paperSize: 'Letter' };

function connectedAt(host: string): ConnectedScanner {
  const capabilities = parseCapabilities(readFixture(...ET_3850, 'ScannerCapabilities.xml'));
  if (!capabilities.ok) {
    throw new Error('фикстура capabilities не разобрана');
  }
  return {
    profile: { scheme: 'https', host, port: 443, basePath: '/eSCL', fingerprint: FINGERPRINT },
    capabilities: capabilities.value,
    options: scanOptionsOf(capabilities.value),
  };
}

const REMEMBERED = storedScannerOf(connectedAt('192.0.2.10'));

/** Настройки в памяти: что запомнено и какие записи сканера пришли. */
function settingsWith(scanner: StoredScanner | null, params: ScanParams | null = PARAMS) {
  let settings: Settings = { scanner, params, saveFolder: null, blankMode: 'hide' };
  const remembered: StoredScanner[] = [];
  const store: SettingsStore = {
    notice: null,
    get: () => settings,
    rememberScanner: (stored) => {
      remembered.push(stored);
      settings = { ...settings, scanner: stored };
      return Promise.resolve(ok(undefined));
    },
    setParams: (next) => {
      settings = { ...settings, params: next };
      return Promise.resolve(ok(undefined));
    },
    setBlankMode: () => Promise.resolve(ok(undefined)),
    rememberSaveFolder: () => Promise.resolve(ok(undefined)),
  };
  return { store, remembered };
}

const capabilitiesReply = (fingerprint: string): Result<BufferedResponse> =>
  ok({
    status: 200,
    location: null,
    contentType: 'text/xml',
    fingerprint,
    body: new TextEncoder().encode(CAPABILITIES),
  });

/** Устройство на адресе; с `held` ответ ждёт `release` — так проверка застаёт ручное подключение. */
function device(answer: Result<BufferedResponse>, held = false) {
  let requests = 0;
  let release: () => void = () => undefined;
  const gate = held
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : Promise.resolve();
  const createTransport = (): ScannerTransport => ({
    request: async () => {
      requests += 1;
      await gate;
      return answer;
    },
    stream: () => Promise.reject(new Error('страницы в этих тестах не запрашиваются')),
    close: () => undefined,
  });
  return {
    connector: { createTransport },
    requests: () => requests,
    release: () => {
      release();
    },
  };
}

function slotOver(
  settings: ReturnType<typeof settingsWith>,
  scanner: ReturnType<typeof device>,
  isPassRunning = () => false,
) {
  let notified = 0;
  const slot = createScannerSlot({
    settings: settings.store,
    connector: scanner.connector,
    notify: () => {
      notified += 1;
    },
    isPassRunning,
  });
  return { slot, notified: () => notified };
}

describe('слот сканера: проверка запомненного', () => {
  it('без запомненного — «нет», без уведомления и без сети', async () => {
    const scanner = device(capabilitiesReply(FINGERPRINT));
    const { slot, notified } = slotOver(settingsWith(null), scanner);

    await slot.check();

    expect(slot.state()).toEqual({ kind: 'none' });
    expect(notified()).toBe(0);
    expect(scanner.requests()).toBe(0);
  });

  it('«проверяем» с запомненными параметрами, затем «готов»; настройки не пишутся', async () => {
    const settings = settingsWith(REMEMBERED);
    const scanner = device(capabilitiesReply(FINGERPRINT), true);
    const { slot, notified } = slotOver(settings, scanner);

    const checked = slot.check();
    expect(slot.state()).toEqual({
      kind: 'checking',
      scanner: scannerInfoOf(REMEMBERED),
      params: PARAMS,
    });
    expect(notified()).toBe(1);
    scanner.release();
    await checked;

    expect(slot.state()).toMatchObject({ kind: 'ready', params: PARAMS });
    expect(slot.current()).toMatchObject({
      kind: 'ready',
      connected: { profile: { host: '192.0.2.10' } },
    });
    expect(notified()).toBe(2);
    expect(settings.remembered).toEqual([]);
  });

  it('молчит — «не отвечает» с причиной; без запомненных параметров — по умолчанию', async () => {
    const scanner = device(fail('scannerUnreachable', { reason: 'timeout' }));
    const { slot } = slotOver(settingsWith(REMEMBERED, null), scanner);

    await slot.check();

    expect(slot.state()).toEqual({
      kind: 'unreachable',
      scanner: scannerInfoOf(REMEMBERED),
      error: { code: 'scannerUnreachable', details: { reason: 'timeout' } },
      params: DEFAULT_SCAN_PARAMS,
    });
  });

  it('чужой сертификат — «другое устройство»', async () => {
    const scanner = device(fail('scannerCertificateChanged'));
    const { slot } = slotOver(settingsWith(REMEMBERED), scanner);

    await slot.check();

    expect(slot.state()).toEqual({
      kind: 'otherDevice',
      scanner: scannerInfoOf(REMEMBERED),
      error: { code: 'scannerCertificateChanged' },
      params: PARAMS,
    });
  });

  it('ручное подключение во время проверки не перезаписывается её исходом', async () => {
    const settings = settingsWith(REMEMBERED);
    const scanner = device(capabilitiesReply(FINGERPRINT), true);
    const { slot, notified } = slotOver(settings, scanner);
    const manual = connectedAt('192.0.2.20');

    const checked = slot.check();
    await slot.use(manual);
    scanner.release();
    await checked;

    expect(slot.current()).toMatchObject({ kind: 'ready', connected: manual });
    expect(settings.remembered).toEqual([storedScannerOf(manual)]);
    // «Проверяем» и подключение; опоздавший исход проверки снимка не шлёт.
    expect(notified()).toBe(2);
  });

  it('идёт проход или сканер уже готов — проверка не начинается', async () => {
    const scanner = device(capabilitiesReply(FINGERPRINT));
    const running = slotOver(settingsWith(REMEMBERED), scanner, () => true);
    await running.slot.check();
    expect(running.slot.state()).toEqual({ kind: 'none' });
    expect(running.notified()).toBe(0);

    const ready = slotOver(settingsWith(REMEMBERED), scanner);
    await ready.slot.use(connectedAt('192.0.2.10'));
    await ready.slot.check();

    expect(scanner.requests()).toBe(0);
    expect(ready.notified()).toBe(1);
  });
});

describe('слот сканера: подключение и параметры', () => {
  it('подключение — «готов» с вариантами устройства и запомненными параметрами', async () => {
    const settings = settingsWith(null);
    const { slot } = slotOver(settings, device(capabilitiesReply(FINGERPRINT)));
    const scanner = connectedAt('192.0.2.10');

    await slot.use(scanner);

    expect(slot.state()).toEqual({
      kind: 'ready',
      scanner: scannerInfoOf(REMEMBERED),
      options: scanner.options,
      params: PARAMS,
    });
    expect(settings.remembered).toEqual([REMEMBERED]);
  });

  it('параметры без сканера и вне вариантов отклоняются кодом, слот не меняется', async () => {
    const { slot, notified } = slotOver(settingsWith(null), device(capabilitiesReply(FINGERPRINT)));
    expect(await slot.setParams(PARAMS)).toEqual(fail('scannerNotConnected'));

    await slot.use(connectedAt('192.0.2.10'));
    expect(await slot.setParams({ ...PARAMS, resolution: 1234 })).toMatchObject({
      ok: false,
      error: { code: 'scanParamsUnsupported' },
    });
    expect(slot.current()).toMatchObject({ params: PARAMS });
    expect(notified()).toBe(1);
  });

  it('другое устройство по адресу прохода — «другое устройство» с причиной', () => {
    const { slot, notified } = slotOver(
      settingsWith(REMEMBERED),
      device(capabilitiesReply(FINGERPRINT)),
    );

    slot.markOtherDevice(REMEMBERED, { code: 'scannerCertificateChanged' });

    expect(slot.state()).toEqual({
      kind: 'otherDevice',
      scanner: scannerInfoOf(REMEMBERED),
      error: { code: 'scannerCertificateChanged' },
      params: PARAMS,
    });
    expect(notified()).toBe(1);
  });
});
