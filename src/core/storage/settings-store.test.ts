import { readdir, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { fail, ok, type Result, type ScanParams } from '@shared';
import { ET_3850, readFixtureText } from '../../../test/support/fixtures';
import { fsError, interceptFs } from '../../../test/support/intercept-fs';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import { createConnector, parseScannerAddress } from '../escl/connect';
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

    expect(store.get()).toEqual({
      scanner: null,
      params: null,
      saveFolder: null,
      blankMode: 'hide',
      straightenMode: 'auto',
      seenHints: [],
    });
    expect(store.notice).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  it('параметры и сканер переживают повторное открытие хранилища', async () => {
    const { root, scanner, file } = await remembered();

    const reopened = await openSettingsStore(root);

    expect(reopened.get()).toEqual({
      scanner,
      params: PARAMS,
      saveFolder: null,
      blankMode: 'hide',
      straightenMode: 'auto',
      seenHints: [],
    });
    expect(scanner).toMatchObject({
      scheme: 'https',
      host: '192.0.2.10',
      port: 443,
      basePath: '/eSCL',
      fingerprint: FINGERPRINT,
    });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 5 });
  });

  it('папка сохранения переживает повторное открытие хранилища (M3)', async () => {
    const { root, scanner } = await remembered();

    expect(await (await openSettingsStore(root)).rememberSaveFolder('E:\\Архив')).toEqual(
      ok(undefined),
    );

    expect((await openSettingsStore(root)).get()).toEqual({
      scanner,
      params: PARAMS,
      saveFolder: 'E:\\Архив',
      blankMode: 'hide',
      straightenMode: 'auto',
      seenHints: [],
    });
  });

  it('файл версии 1 читается без потерь и переписывается текущей версией только при записи (M3)', async () => {
    const root = await makeTempDataRoot();
    const file = layoutOf(root).settingsFile;
    const v1 = JSON.stringify({ version: 1, scanner: null, params: PARAMS });
    await writeFile(file, v1);

    const store = await openSettingsStore(root);

    expect(store.notice).toBeNull();
    expect(store.get()).toEqual({
      scanner: null,
      params: PARAMS,
      saveFolder: null,
      blankMode: 'hide',
      straightenMode: 'auto',
      seenHints: [],
    });
    expect(await readFile(file, 'utf8')).toBe(v1);

    await store.rememberSaveFolder('E:\\Архив');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 5,
      scanner: null,
      params: PARAMS,
      saveFolder: 'E:\\Архив',
      blankMode: 'hide',
      straightenMode: 'auto',
      seenHints: [],
    });
  });

  it('неизвестное поле в файле версии 1 — несовместимость: файл не переписывается', async () => {
    const root = await makeTempDataRoot();
    const file = layoutOf(root).settingsFile;
    const content = JSON.stringify({ version: 1, scanner: null, params: null, theme: 'dark' });
    await writeFile(file, content);

    const store = await openSettingsStore(root);
    await store.rememberSaveFolder('E:\\Архив');

    expect(store.notice).toBe('settingsIncompatible');
    expect(await readFile(file, 'utf8')).toBe(content);
  });

  it('файл настроек с маркером новее понятного не переписывается; приложение работает с дефолтами в памяти', async () => {
    const root = await makeTempDataRoot();
    const file = layoutOf(root).settingsFile;
    const newer = JSON.stringify({ version: 6, profiles: [{ name: 'будущее' }] });
    await writeFile(file, newer);

    const store = await openSettingsStore(root);
    expect(store.notice).toBe('settingsIncompatible');
    expect(store.get()).toEqual({
      scanner: null,
      params: null,
      saveFolder: null,
      blankMode: 'hide',
      straightenMode: 'auto',
      seenHints: [],
    });

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
    const content = JSON.stringify({
      version: 5,
      scanner: null,
      params: null,
      saveFolder: null,
      blankMode: 'hide',
      straightenMode: 'auto',
      seenHints: [],
      theme: 'dark',
    });
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
    expect(store.get()).toEqual({
      scanner: null,
      params: null,
      saveFolder: null,
      blankMode: 'hide',
      straightenMode: 'auto',
      seenHints: [],
    });
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
    await session.beginPass({ scanner, params: PARAMS, pixelLimit: 1000 }, null);
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
      await checkRememberedScanner(
        {
          scanner: null,
          params: null,
          saveFolder: null,
          blankMode: 'hide',
          seenHints: [],
          straightenMode: 'auto',
        },
        { createTransport },
      ),
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

    expect(check).toEqual({ state: 'otherDevice', scanner, error: null });
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
      error: { code: 'scannerCertificateChanged' },
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

    expect(check).toEqual({
      state: 'unreachable',
      scanner,
      error: { code: 'scannerUnreachable', details: { reason: 'refused' } },
    });
    expect(profiles.map((profile) => profile.scheme)).toEqual(['https']);
  });

  /** Часы без настоящего ожидания: «занят» пережидается мгновенно (M5, KTD6). */
  const instantClock = {
    now: (() => {
      let now = 0;
      return () => (now += 1000);
    })(),
    sleep: () => Promise.resolve(),
  };

  it.each([
    [
      'таймаут',
      fail('scannerUnreachable', { reason: 'timeout' }),
      'unreachable',
      'scannerUnreachable',
    ],
    ['проверка отменена', fail('canceled'), 'unreachable', 'canceled'],
    // Тот же сканер, пока занят или просыпается, — не «другое устройство». «Занят» пережидается
    // до потолка, причина остаётся в снимке (M5, R11).
    ['сканер занят: 503 до потолка', ok({ status: 503 }), 'unreachable', 'scannerBusy'],
    ['сбой сканера: 500', ok({ status: 500 }), 'unreachable', 'notEsclScanner'],
    [
      'ответ не разобран',
      fail('scannerBadResponse', { reason: 'tooLarge' }),
      'unreachable',
      'scannerBadResponse',
    ],
    ['по адресу не сканер: 404', ok({ status: 404 }), 'otherDevice', 'notEsclScanner'],
    ['по адресу не сканер: HTML', ok({ status: 200 }), 'otherDevice', 'notEsclScanner'],
    [
      'сертификат сменился',
      fail('scannerCertificateChanged'),
      'otherDevice',
      'scannerCertificateChanged',
    ],
  ] as const)('%s → %s', async (_title, reply, state, code) => {
    const { store, scanner } = await remembered();
    const answer = reply.ok
      ? ok({
          ...reply.value,
          location: null,
          contentType: null,
          fingerprint: FINGERPRINT,
          body: new TextEncoder().encode('<html></html>'),
        })
      : reply;

    const check = await checkRememberedScanner(store.get(), {
      ...deviceAt(() => answer),
      clock: instantClock,
    });

    expect(check).toMatchObject({ state, scanner });
    // Причина — кодом: интерфейс и тесты не гадают по состоянию.
    expect(check).toHaveProperty('error.code', code);
  });

  it('сканер без автоподачи на адресе запомненного — другое устройство', async () => {
    const { store } = await remembered();
    const noAdf = readFixtureText('escl', 'no-adf', 'ScannerCapabilities.xml');

    const check = await checkRememberedScanner(
      store.get(),
      deviceAt(() => ({ fingerprint: FINGERPRINT, capabilities: noAdf })),
    );

    expect(check).toMatchObject({ state: 'otherDevice', error: { code: 'scannerNoAdf' } });
  });

  it('запись проверяется схемой: негодное значение не попадает ни в файл, ни в память', async () => {
    const { store, scanner, file, bytes } = await remembered();
    const garbage = { ...scanner, host: '', token: 'лишнее' } as unknown as StoredScanner;

    expect(await store.rememberScanner(garbage)).toMatchObject({
      ok: false,
      error: { code: 'storageFailed', details: { reason: 'schema' } },
    });

    expect(store.get().scanner).toEqual(scanner);
    expect((await readFile(file)).equals(bytes)).toBe(true);
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

describe('настройки: режим пустых оборотов (M4, R1)', () => {
  it('файл версии 2 читается с режимом «скрывать» и переписывается текущей версией только при записи', async () => {
    const root = await makeTempDataRoot();
    const file = layoutOf(root).settingsFile;
    const v2 = JSON.stringify({ version: 2, scanner: null, params: PARAMS, saveFolder: null });
    await writeFile(file, v2);

    const store = await openSettingsStore(root);

    expect(store.notice).toBeNull();
    expect(store.get()).toEqual({
      scanner: null,
      params: PARAMS,
      saveFolder: null,
      blankMode: 'hide',
      straightenMode: 'auto',
      seenHints: [],
    });
    expect(await readFile(file, 'utf8')).toBe(v2);

    expect(await store.setBlankMode('mark')).toEqual(ok(undefined));
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 5,
      scanner: null,
      params: PARAMS,
      saveFolder: null,
      blankMode: 'mark',
      seenHints: [],
      straightenMode: 'auto',
    });
  });

  it('режим помнится между запусками; негодное значение не попадает ни в файл, ни в память', async () => {
    const root = await makeTempDataRoot();
    const store = await openSettingsStore(root);

    expect(await store.setBlankMode('keep')).toEqual(ok(undefined));
    expect((await openSettingsStore(root)).get().blankMode).toBe('keep');

    expect(await store.setBlankMode('auto' as never)).toEqual(
      fail('storageFailed', { reason: 'schema' }),
    );
    expect(store.get().blankMode).toBe('keep');
    expect((await openSettingsStore(root)).get().blankMode).toBe('keep');
  });

  it('B-4: файл версии 3 читается с пустым списком подсказок и переписывается только при записи', async () => {
    const root = await makeTempDataRoot();
    const file = layoutOf(root).settingsFile;
    const v3 = JSON.stringify({
      version: 3,
      scanner: null,
      params: PARAMS,
      saveFolder: null,
      blankMode: 'mark',
    });
    await writeFile(file, v3);

    const store = await openSettingsStore(root);

    expect(store.notice).toBeNull();
    expect(store.get().seenHints).toEqual([]);
    expect(store.get().blankMode).toBe('mark');
    expect(await readFile(file, 'utf8')).toBe(v3);

    expect(await store.markHintSeen('docsSplit')).toEqual(ok(undefined));
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      version: 5,
      blankMode: 'mark',
      seenHints: ['docsSplit'],
    });
  });

  it('B-4: показанная подсказка помнится между запусками; повтор — без изменений, неизвестная — отказ', async () => {
    const root = await makeTempDataRoot();
    const store = await openSettingsStore(root);

    expect(await store.markHintSeen('docsSplit')).toEqual(ok(undefined));
    expect(await store.markHintSeen('docsSplit')).toEqual(ok(undefined));
    expect((await openSettingsStore(root)).get().seenHints).toEqual(['docsSplit']);

    expect(await store.markHintSeen('nope' as never)).toEqual(
      fail('storageFailed', { reason: 'schema' }),
    );
    expect(store.get().seenHints).toEqual(['docsSplit']);
  });
});

describe('настройки: режим выравнивания (M6, R13)', () => {
  it('файл версии 4 читается с режимом «выравнивать» и переписывается текущей версией только при записи', async () => {
    const root = await makeTempDataRoot();
    const file = layoutOf(root).settingsFile;
    const v4 = JSON.stringify({
      version: 4,
      scanner: null,
      params: PARAMS,
      saveFolder: 'E:\\Архив',
      blankMode: 'mark',
      seenHints: ['docsSplit'],
    });
    await writeFile(file, v4);

    const store = await openSettingsStore(root);

    expect(store.notice).toBeNull();
    expect(store.get()).toEqual({
      scanner: null,
      params: PARAMS,
      saveFolder: 'E:\\Архив',
      blankMode: 'mark',
      seenHints: ['docsSplit'],
      straightenMode: 'auto',
    });
    expect(await readFile(file, 'utf8')).toBe(v4);

    expect(await store.setStraightenMode('off')).toEqual(ok(undefined));
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 5,
      scanner: null,
      params: PARAMS,
      saveFolder: 'E:\\Архив',
      blankMode: 'mark',
      seenHints: ['docsSplit'],
      straightenMode: 'off',
    });
  });

  it('режим помнится между запусками; негодное значение не попадает ни в файл, ни в память', async () => {
    const root = await makeTempDataRoot();
    const store = await openSettingsStore(root);

    expect(store.get().straightenMode).toBe('auto');
    expect(await store.setStraightenMode('off')).toEqual(ok(undefined));
    expect((await openSettingsStore(root)).get().straightenMode).toBe('off');

    expect(await store.setStraightenMode('always' as never)).toEqual(
      fail('storageFailed', { reason: 'schema' }),
    );
    expect(store.get().straightenMode).toBe('off');
    expect((await openSettingsStore(root)).get().straightenMode).toBe('off');
  });
});
