import { readdir, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { fail, ok, type Result } from '@shared';
import { ET_3850, readFixtureText } from '../../../test/support/fixtures';
import { fsError, interceptFs } from '../../../test/support/intercept-fs';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import { createConnector, parseScannerAddress } from '../escl/connect';
import type { ScanParams } from '../escl/scan-settings';
import type { BufferedResponse, ScannerProfile, ScannerTransport } from '../escl/transport';
import { layoutOf } from './layout';
import { createSessionStore } from './session-store';
import { checkRememberedScanner, openSettingsStore } from './settings-store';
import { realStorageFs } from './storage-fs';
import { storedScannerOf, type StoredScanner } from './stored-scanner';

const CAPABILITIES = readFixtureText(...ET_3850, 'ScannerCapabilities.xml');
const FINGERPRINT = 'ab'.repeat(32);
const OTHER_FINGERPRINT = 'cd'.repeat(32);
const PARAMS: ScanParams = { colorMode: 'RGB24', resolution: 600, paperSize: 'Letter' };

const withUuid = (uuid: string): string =>
  CAPABILITIES.replace(/<scan:UUID>[^<]*<\/scan:UUID>/, `<scan:UUID>${uuid}</scan:UUID>`);

interface Device {
  readonly fingerprint: string;
  readonly capabilities: string;
}

/**
 * Подставное устройство на адресе: отвечает capabilities и, как настоящий транспорт, отклоняет
 * соединение, когда запомненный отпечаток не совпал с его сертификатом (KTD-40).
 */
function deviceAt(answer: (profile: ScannerProfile) => Result<BufferedResponse> | Device) {
  const profiles: ScannerProfile[] = [];
  const createTransport = (profile: ScannerProfile): ScannerTransport => ({
    request: () => {
      profiles.push(profile);
      const reply = answer(profile);
      if ('ok' in reply) {
        return Promise.resolve(reply);
      }
      if (profile.fingerprint !== null && profile.fingerprint !== reply.fingerprint) {
        return Promise.resolve(fail('scannerCertificateChanged'));
      }
      return Promise.resolve(
        ok({
          status: 200,
          location: null,
          contentType: 'text/xml',
          fingerprint: reply.fingerprint,
          body: new TextEncoder().encode(reply.capabilities),
        }),
      );
    },
    stream: () => Promise.reject(new Error('страницы в этих тестах не запрашиваются')),
    close: () => undefined,
  });
  return { createTransport, profiles };
}

const ET: Device = { fingerprint: FINGERPRINT, capabilities: CAPABILITIES };

/** Подключение по адресу — так сканер попадает в настройки в приложении. */
async function connect(device: Device, address = '192.0.2.10'): Promise<StoredScanner> {
  const parsed = parseScannerAddress(address);
  if (!parsed.ok) {
    throw new Error('адрес не разобран');
  }
  const connected = await createConnector(deviceAt(() => device)).connect(parsed.value);
  if (!connected.ok) {
    throw new Error(`подключение отклонено: ${connected.error.code}`);
  }
  return storedScannerOf(connected.value);
}

async function remembered() {
  const root = await makeTempDataRoot();
  const file = layoutOf(root).settingsFile;
  const store = await openSettingsStore(root);
  const scanner = await connect(ET);
  await store.rememberScanner(scanner);
  await store.setParams(PARAMS);
  return { root, file, store, scanner, bytes: await readFile(file) };
}

describe('настройки', () => {
  it('без файла — пусто и без уведомлений; каталог не создаётся', async () => {
    const root = await makeTempDataRoot();

    const store = await openSettingsStore(root);

    expect(store.get()).toEqual({ scanner: null, params: null });
    expect(store.notice).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  it('параметры и сканер переживают повторное открытие хранилища', async () => {
    const { root, scanner, file } = await remembered();

    const reopened = await openSettingsStore(root);

    expect(reopened.get()).toEqual({ scanner, params: PARAMS });
    expect(scanner).toMatchObject({
      scheme: 'https',
      host: '192.0.2.10',
      port: 443,
      basePath: '/eSCL',
      fingerprint: FINGERPRINT,
    });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('файл настроек с маркером новее понятного не переписывается; приложение работает с дефолтами в памяти', async () => {
    const root = await makeTempDataRoot();
    const file = layoutOf(root).settingsFile;
    const newer = JSON.stringify({ version: 2, profiles: [{ name: 'будущее' }] });
    await writeFile(file, newer);

    const store = await openSettingsStore(root);
    expect(store.notice).toBe('settingsIncompatible');
    expect(store.get()).toEqual({ scanner: null, params: null });

    expect(await store.setParams(PARAMS)).toEqual(ok(undefined));
    expect(await store.rememberScanner(await connect(ET))).toEqual(ok(undefined));

    expect(store.get().params).toEqual(PARAMS);
    expect(store.get().scanner?.host).toBe('192.0.2.10');
    expect(await readFile(file, 'utf8')).toBe(newer);
    expect(await readdir(root)).toEqual(['settings.json']);
  });

  it('неизвестное поле при текущей версии — тоже несовместимость: файл не переписывается', async () => {
    const root = await makeTempDataRoot();
    const file = layoutOf(root).settingsFile;
    const content = JSON.stringify({ version: 1, scanner: null, params: null, theme: 'dark' });
    await writeFile(file, content);

    const store = await openSettingsStore(root);
    await store.setParams(PARAMS);

    expect(store.notice).toBe('settingsIncompatible');
    expect(await readFile(file, 'utf8')).toBe(content);
  });

  it('нечитаемый файл настроек отодвигается, а не удаляется', async () => {
    const root = await makeTempDataRoot();
    await writeFile(layoutOf(root).settingsFile, '{ "version": 1, "scanner": ');

    const store = await openSettingsStore(root);

    expect(store.notice).toBe('settingsUnreadable');
    expect(store.get()).toEqual({ scanner: null, params: null });
    const names = await readdir(root);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^settings\.json\.unreadable-[0-9a-f]{12}$/);

    // Новые настройки пишутся рядом, отодвинутая копия остаётся.
    await store.setParams(PARAMS);
    expect((await readdir(root)).sort()).toEqual([names[0], 'settings.json'].sort());
    expect((await openSettingsStore(root)).get().params).toEqual(PARAMS);
  });

  it('отказ записи возвращается кодом, значение остаётся в памяти', async () => {
    const root = await makeTempDataRoot();
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (call.op === 'rename') {
        throw fsError('ENOSPC');
      }
    });
    const store = await openSettingsStore(root, { fs, retry: { ceilingMs: 0 } });

    expect(await store.setParams(PARAMS)).toEqual(fail('storageFull'));
    expect(store.get().params).toEqual(PARAMS);
  });

  it('настройки и сессия живут в разных файлах; закрытие сессии настройки не трогает', async () => {
    const { root, file, scanner, bytes } = await remembered();
    const session = createSessionStore(root);
    await session.beginPass({ scanner, params: PARAMS, pixelLimit: 1000 });
    await session.acceptPage(
      (async function* () {
        await Promise.resolve();
        yield Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
      })(),
    );
    await session.endSegment('completed');

    expect(await session.closeSession()).toEqual(ok(undefined));

    expect(await readdir(root)).toEqual(['settings.json']);
    expect((await readFile(file)).equals(bytes)).toBe(true);
  });
});

describe('запомненный сканер при запуске', () => {
  it('сканер ещё не подключали', async () => {
    const { createTransport, profiles } = deviceAt(() => ET);

    expect(
      await checkRememberedScanner({ scanner: null, params: null }, { createTransport }),
    ).toEqual({ state: 'none' });
    expect(profiles).toEqual([]);
  });

  it('то же устройство отвечает — готов; проба идёт с запомненным отпечатком', async () => {
    const { store, scanner } = await remembered();
    const { createTransport, profiles } = deviceAt(() => ET);

    const check = await checkRememberedScanner(store.get(), { createTransport });

    expect(check).toMatchObject({ state: 'ready', params: PARAMS });
    expect(profiles).toEqual([
      {
        scheme: 'https',
        host: '192.0.2.10',
        port: 443,
        basePath: '/eSCL',
        fingerprint: FINGERPRINT,
      },
    ]);
    if (check.state === 'ready') {
      expect(storedScannerOf(check.connected)).toEqual(scanner);
      expect(check.connected.options.resolutions).toEqual([100, 200, 300, 600]);
    }
  });

  it('запомненное разрешение, которого нет у устройства, заменяется дефолтом', async () => {
    const { store, file } = await remembered();
    await store.setParams({ ...PARAMS, resolution: 1200 });
    const bytes = await readFile(file);

    const check = await checkRememberedScanner(
      store.get(),
      deviceAt(() => ET),
    );

    expect(check).toMatchObject({ state: 'ready', params: { ...PARAMS, resolution: 300 } });
    // Замена — только для этого запуска: запомненное в файле не переписывается.
    expect((await readFile(file)).equals(bytes)).toBe(true);
  });

  it('устройство с другим UUID на том же адресе даёт состояние «другое устройство», файл настроек не меняется', async () => {
    const { store, scanner, file, bytes } = await remembered();
    const impostor = deviceAt(() => ({
      fingerprint: FINGERPRINT,
      capabilities: withUuid('ffffffff-ffff-4fff-8fff-ffffffffffff'),
    }));

    const check = await checkRememberedScanner(store.get(), impostor);

    expect(check).toEqual({ state: 'otherDevice', scanner });
    expect(store.get().scanner).toEqual(scanner);
    expect((await readFile(file)).equals(bytes)).toBe(true);
  });

  it('тот же UUID с другим отпечатком сертификата даёт «другое устройство», файл настроек не меняется; повторное подключение запоминает новый отпечаток', async () => {
    const { root, store, scanner, file, bytes } = await remembered();
    const replaced: Device = { fingerprint: OTHER_FINGERPRINT, capabilities: CAPABILITIES };

    expect(
      await checkRememberedScanner(
        store.get(),
        deviceAt(() => replaced),
      ),
    ).toEqual({
      state: 'otherDevice',
      scanner,
    });
    expect((await readFile(file)).equals(bytes)).toBe(true);

    // Повторное подключение в модалке — явное действие пользователя.
    await store.rememberScanner(await connect(replaced));

    const reopened = await openSettingsStore(root);
    expect(reopened.get().scanner).toEqual({ ...scanner, fingerprint: OTHER_FINGERPRINT });
    expect(
      await checkRememberedScanner(
        reopened.get(),
        deviceAt(() => replaced),
      ),
    ).toMatchObject({
      state: 'ready',
    });
  });

  it('запомненный профиль HTTPS с закрытым портом даёт «не отвечает» без запроса по HTTP', async () => {
    const { store, scanner } = await remembered();
    const { createTransport, profiles } = deviceAt(() =>
      fail('scannerUnreachable', { reason: 'refused' }),
    );

    const check = await checkRememberedScanner(store.get(), { createTransport });

    expect(check).toEqual({ state: 'unreachable', scanner });
    expect(profiles.map((profile) => profile.scheme)).toEqual(['https']);
  });

  it.each([
    ['таймаут', fail('scannerUnreachable', { reason: 'timeout' }), 'unreachable'],
    ['проверка отменена', fail('canceled'), 'unreachable'],
    ['по адресу не сканер', ok({ status: 404 }), 'otherDevice'],
    ['ответ не разобран', fail('scannerBadResponse', { reason: 'tooLarge' }), 'otherDevice'],
  ] as const)('%s → %s', async (_title, reply, state) => {
    const { store } = await remembered();
    const answer = reply.ok
      ? ok({
          ...reply.value,
          location: null,
          contentType: null,
          fingerprint: FINGERPRINT,
          body: new Uint8Array(),
        })
      : reply;

    expect(
      await checkRememberedScanner(
        store.get(),
        deviceAt(() => answer),
      ),
    ).toMatchObject({
      state,
    });
  });

  it('сканер на HTTP без отпечатка и UUID узнаётся по адресу', async () => {
    const root = await makeTempDataRoot();
    const store = await openSettingsStore(root);
    const plain: StoredScanner = {
      scheme: 'http',
      host: '192.0.2.20',
      port: 80,
      basePath: '/eSCL',
      fingerprint: null,
      uuid: null,
      name: null,
    };
    await store.rememberScanner(plain);
    const noUuid = CAPABILITIES.replace(/<scan:UUID>[^<]*<\/scan:UUID>/, '');
    const device = deviceAt(() =>
      ok({
        status: 200,
        location: null,
        contentType: null,
        fingerprint: null,
        body: new TextEncoder().encode(noUuid),
      }),
    );

    expect(await checkRememberedScanner(store.get(), device)).toMatchObject({ state: 'ready' });
  });
});
