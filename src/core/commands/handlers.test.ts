import {
  BRIDGE_CHANNELS,
  EMPTY_EDITS,
  fail,
  ok,
  type BridgeCommand,
  type DiscoveryState,
  type Result,
  type SaveDocumentsReport,
  type SavePdfReport,
  type SessionEdits,
  type Snapshot,
} from '@shared';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectedScanner, Connector, ScannerAddress } from '../escl/connect';
import type { Discovery } from '../discovery/mdns';
import type { PassService } from '../scan/pass-service';
import { addressOf, createCommands } from './handlers';
import { MAX_EDIT_ITEMS } from './schemas';

// Обработчики команд моста (план M1, U18, KTD-39): верный вход — успех в конверте, мусор — код
// неверного входа, доменный отказ службы — код, а не исключение. Служба, поиск и подключение —
// подставные: сам проход проверяется против эмулятора.

const EMPTY_SNAPSHOT: Snapshot = {
  seq: 0,
  scanner: { kind: 'none' },
  session: null,
  assembly: null,
  pass: null,
  canResume: false,
  canAccept: false,
  storage: { incompatible: false, unsaved: false },
  notices: [],
};

const PARAMS = { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' } as const;

const CONNECTED = {
  profile: { scheme: 'https', host: '127.0.0.1', port: 9443, basePath: '/eSCL', fingerprint: null },
} as unknown as ConnectedScanner;

function setup(snapshot: Snapshot = EMPTY_SNAPSHOT) {
  const service = {
    snapshot: vi.fn(() => snapshot),
    checkRememberedScanner: vi.fn(() => Promise.resolve()),
    useScanner: vi.fn((): Promise<Result<void>> => Promise.resolve(ok(undefined))),
    setParams: vi.fn((): Promise<Result<void>> => Promise.resolve(ok(undefined))),
    startPass: vi.fn(() =>
      Promise.resolve(ok({ end: 'completed' as const, pages: 3, error: null })),
    ),
    stopPass: vi.fn((): Promise<Result<void>> => Promise.resolve(ok(undefined))),
    acceptPass: vi.fn((): Promise<Result<void>> => Promise.resolve(ok(undefined))),
    declineBacks: vi.fn((): Promise<Result<void>> => Promise.resolve(ok(undefined))),
    setEdits: vi.fn((): Promise<Result<void>> => Promise.resolve(ok(undefined))),
    savePdf: vi.fn((): Promise<Result<SavePdfReport>> =>
      Promise.resolve(ok({ canceled: false, fileName: 'скан.pdf', directory: 'D:\\Сканы' })),
    ),
    saveDocuments: vi.fn((): Promise<Result<SaveDocumentsReport>> =>
      Promise.resolve(ok({ folder: 'D:\\Сканы', written: [], failed: [] })),
    ),
    closeSession: vi.fn((): Promise<Result<void>> => Promise.resolve(ok(undefined))),
    interrupt: vi.fn(() => Promise.resolve()),
    pageInfo: vi.fn(() => null),
    readPage: vi.fn(() => Promise.resolve(fail('pageUnavailable'))),
  } satisfies PassService;

  let state: DiscoveryState = { scanners: [], failure: null };
  let onChange: (() => void) | null = null;
  const stop = vi.fn();
  const discovery: Discovery = {
    state: () => state,
    addressOf: (id) =>
      id === 'abcdef01-1'
        ? { scheme: null, host: '127.0.0.1', port: 9443, basePath: '/eSCL' }
        : null,
    stop,
  };
  const startDiscovery = vi.fn((options: { onChange?: () => void }) => {
    onChange = options.onChange ?? null;
    return discovery;
  });
  const announce = (next: DiscoveryState): void => {
    state = next;
    onChange?.();
  };

  const connect = vi.fn((address: ScannerAddress) =>
    Promise.resolve(address.host === '' ? fail('invalidInput') : ok(CONNECTED)),
  );
  const cancel = vi.fn();
  const connector: Connector = { connect, cancel };

  const openDataFolder = vi.fn((): Promise<Result<void>> => Promise.resolve(ok(undefined)));
  const askSavePdfPath = vi.fn((): Promise<string | null> =>
    Promise.resolve('D:\\Сканы\\скан.pdf'),
  );
  const askSaveFolder = vi.fn((): Promise<string | null> => Promise.resolve('E:\\Архив'));
  const discoveryEvents: number[] = [];
  const commands = createCommands({
    service,
    openDataFolder,
    askSavePdfPath,
    defaultSaveFolder: 'C:\\Users\\Документы',
    askSaveFolder,
    onDiscoveryChanged: (seq) => discoveryEvents.push(seq),
    startDiscovery,
    connector,
  });
  return {
    ...commands,
    service,
    startDiscovery,
    stop,
    announce,
    connect,
    connector,
    cancel,
    openDataFolder,
    askSavePdfPath,
    askSaveFolder,
    discoveryEvents,
  };
}

const invalid = (result: Result<unknown>): boolean =>
  !result.ok && result.error.code === 'invalidInput';

describe('команды без входа', () => {
  const EMPTY_COMMANDS: readonly BridgeCommand[] = [
    'getSnapshot',
    'startDiscovery',
    'getDiscovery',
    'stopDiscovery',
    'cancelConnect',
    'recheckScanner',
    'startPass',
    'stopPass',
    'acceptPass',
    'declineBacks',
    'savePdf',
    'closeSession',
    'openDataFolder',
  ];

  it('с `undefined` возвращают успех в конверте', async () => {
    const { handlers } = setup();
    for (const command of EMPTY_COMMANDS) {
      expect(await handlers[command](undefined), command).toMatchObject({ ok: true });
    }
  });

  it.each([null, {}, '', 0, [], { token: 'x' }, 'C:\\data'])(
    'любой аргумент (%j) отклоняется кодом неверного входа — и у openDataFolder',
    async (argument) => {
      const { handlers, service, openDataFolder } = setup();
      for (const command of EMPTY_COMMANDS) {
        expect(invalid(await handlers[command](argument)), command).toBe(true);
      }
      expect(openDataFolder).not.toHaveBeenCalled();
      expect(service.startPass).not.toHaveBeenCalled();
    },
  );

  it('каждая команда контракта зарегистрирована обработчиком', () => {
    const { handlers } = setup();
    expect(Object.keys(handlers).sort()).toEqual(Object.keys(BRIDGE_CHANNELS).sort());
  });
});

describe('снимок и проход', () => {
  it('getSnapshot отдаёт снимок службы как есть', async () => {
    const { handlers } = setup();
    expect(await handlers.getSnapshot(undefined)).toEqual(ok(EMPTY_SNAPSHOT));
  });

  it('startPass отдаёт отчёт прохода; доменный отказ службы доходит кодом', async () => {
    const { handlers, service } = setup();
    expect(await handlers.startPass(undefined)).toEqual(
      ok({ end: 'completed', pages: 3, error: null }),
    );

    service.startPass.mockResolvedValueOnce(fail('scanNoPaper'));
    expect(await handlers.startPass(undefined)).toEqual(fail('scanNoPaper'));
  });

  it('stopPass, acceptPass, closeSession зовут службу и переводят отказ кодом', async () => {
    const { handlers, service } = setup();
    service.stopPass.mockResolvedValueOnce(fail('sessionConflict', { reason: 'noRunningPass' }));

    expect(await handlers.stopPass(undefined)).toEqual(
      fail('sessionConflict', { reason: 'noRunningPass' }),
    );
    expect(await handlers.acceptPass(undefined)).toEqual(ok(undefined));
    expect(await handlers.closeSession(undefined)).toEqual(ok(undefined));
    expect(service.acceptPass).toHaveBeenCalledOnce();
    expect(service.closeSession).toHaveBeenCalledOnce();
  });

  it('declineBacks зовёт службу; отказ доходит кодом (M2, U3)', async () => {
    const { handlers, service } = setup();

    expect(await handlers.declineBacks(undefined)).toEqual(ok(undefined));
    expect(service.declineBacks).toHaveBeenCalledOnce();

    service.declineBacks.mockResolvedValueOnce(fail('sessionConflict', { reason: 'backsPresent' }));
    expect(await handlers.declineBacks(undefined)).toEqual(
      fail('sessionConflict', { reason: 'backsPresent' }),
    );
  });

  it('savePdf отдаёт отчёт сохранения; диалог пути — функция из контекста main (M2, U6)', async () => {
    const { handlers, service, askSavePdfPath } = setup();

    expect(await handlers.savePdf(undefined)).toEqual(
      ok({ canceled: false, fileName: 'скан.pdf', directory: 'D:\\Сканы' }),
    );
    expect(service.savePdf).toHaveBeenCalledExactlyOnceWith(askSavePdfPath);

    service.savePdf.mockResolvedValueOnce(fail('saveWriteFailed', { reason: 'EACCES' }));
    expect(await handlers.savePdf(undefined)).toEqual(
      fail('saveWriteFailed', { reason: 'EACCES' }),
    );
  });

  it('setEdits: строгая схема, затем служба — правки и тумблер одним вызовом (M3, U3)', async () => {
    const { handlers, service } = setup();
    const edits: SessionEdits = {
      order: ['p01-s01-0002', 'p01-s01-0001'],
      rotations: { 'p01-s01-0001': 90 },
      deleted: ['p02-s01-0001'],
      cuts: [1],
      names: ['', 'Договор'],
    };

    expect(await handlers.setEdits({ edits, rotate180: true })).toEqual(ok(undefined));
    expect(service.setEdits).toHaveBeenCalledExactlyOnceWith(edits, true);
    expect(await handlers.setEdits({ edits: EMPTY_EDITS, rotate180: false })).toEqual(
      ok(undefined),
    );
    expect(service.setEdits).toHaveBeenLastCalledWith(EMPTY_EDITS, false);

    const tooMany = Array.from({ length: MAX_EDIT_ITEMS + 1 }, () => 'p01-s01-0001');
    const garbage = [
      true,
      { edits },
      { edits, rotate180: 'да' },
      { edits, rotate180: true, extra: 1 },
      { edits: { ...edits, extra: 1 }, rotate180: false },
      { edits: { ...edits, names: ['Договор'] }, rotate180: false },
      { edits: { ...edits, cuts: [2, 1], names: ['', '', ''] }, rotate180: false },
      { edits: { ...edits, cuts: [-1] }, rotate180: false },
      { edits: { ...edits, rotations: { 'p01-s01-0001': 45 } }, rotate180: false },
      { edits: { ...edits, order: ['../p01-s01-0001'] }, rotate180: false },
      { edits: { ...edits, deleted: tooMany }, rotate180: false },
      { edits: { ...edits, names: ['', 'я'.repeat(201)] }, rotate180: false },
      {},
      null,
      undefined,
    ];
    for (const [index, input] of garbage.entries()) {
      expect(invalid(await handlers.setEdits(input)), `мусор №${index}`).toBe(true);
    }
    expect(service.setEdits).toHaveBeenCalledTimes(2);
  });

  it('папка пакета: по умолчанию «Документы», «Выбрать…» меняет, отказ в диалоге — нет (M3, U4)', async () => {
    const { handlers, askSaveFolder } = setup();

    expect(await handlers.getSaveFolder(undefined)).toEqual(ok('C:\\Users\\Документы'));
    expect(await handlers.chooseSaveFolder(undefined)).toEqual(
      ok({ canceled: false, folder: 'E:\\Архив' }),
    );
    expect(askSaveFolder).toHaveBeenLastCalledWith('C:\\Users\\Документы');

    askSaveFolder.mockResolvedValueOnce(null);
    expect(await handlers.chooseSaveFolder(undefined)).toEqual(
      ok({ canceled: true, folder: 'E:\\Архив' }),
    );
    expect(await handlers.getSaveFolder(undefined)).toEqual(ok('E:\\Архив'));
  });

  it('saveDocuments: строгая схема, затем служба с текущей папкой (M3, U4)', async () => {
    const { handlers, service } = setup();
    await handlers.chooseSaveFolder(undefined);
    const request = { mode: 'separate', names: ['Счёт', 'Акт'], retry: false } as const;

    expect(await handlers.saveDocuments(request)).toEqual(
      ok({ folder: 'D:\\Сканы', written: [], failed: [] }),
    );
    expect(service.saveDocuments).toHaveBeenCalledExactlyOnceWith('E:\\Архив', request);

    const garbage = [
      undefined,
      { mode: 'all', names: ['А'], retry: false },
      { mode: 'single', names: [], retry: false },
      { mode: 'single', names: ['я'.repeat(201)], retry: false },
      { mode: 'single', names: ['А'], retry: 'нет' },
      { mode: 'single', names: ['А'], retry: false, folder: 'C:\\' },
    ];
    for (const [index, input] of garbage.entries()) {
      expect(invalid(await handlers.saveDocuments(input)), `мусор №${index}`).toBe(true);
    }
    expect(service.saveDocuments).toHaveBeenCalledTimes(1);
  });

  it('setScanParams: строгая схема, затем служба', async () => {
    const { handlers, service } = setup();

    expect(await handlers.setScanParams(PARAMS)).toEqual(ok(undefined));
    expect(service.setParams).toHaveBeenCalledExactlyOnceWith(PARAMS);
    for (const garbage of [
      { ...PARAMS, resolution: '300' },
      { ...PARAMS, colorMode: 'CMYK' },
      { ...PARAMS, extra: 1 },
      { colorMode: 'Grayscale8' },
      null,
      undefined,
    ]) {
      expect(invalid(await handlers.setScanParams(garbage)), JSON.stringify(garbage)).toBe(true);
    }
    expect(service.setParams).toHaveBeenCalledOnce();
  });

  it('recheckScanner зовёт проверку запомненного сканера; исход — в снимке', async () => {
    const { handlers, service } = setup();
    expect(await handlers.recheckScanner(undefined)).toEqual(ok(undefined));
    expect(service.checkRememberedScanner).toHaveBeenCalledOnce();
  });

  it('cancelConnect отменяет идущее подключение', async () => {
    const { handlers, cancel } = setup();
    expect(await handlers.cancelConnect(undefined)).toEqual(ok(undefined));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('openDataFolder зовёт main без аргументов', async () => {
    const { handlers, openDataFolder } = setup();
    expect(await handlers.openDataFolder(undefined)).toEqual(ok(undefined));
    expect(openDataFolder).toHaveBeenCalledExactlyOnceWith();
  });

  it('openDataFolder: отказ main доходит кодом, а не успехом', async () => {
    const { handlers, openDataFolder } = setup();
    openDataFolder.mockResolvedValueOnce(fail('storageFailed', { reason: 'openPath' }));

    expect(await handlers.openDataFolder(undefined)).toEqual(
      fail('storageFailed', { reason: 'openPath' }),
    );
  });
});

describe('поиск устройств', () => {
  it('startDiscovery запускает поиск и отдаёт состояние; повторный — останавливает прежний', async () => {
    const { handlers, startDiscovery, stop } = setup();

    expect(await handlers.startDiscovery(undefined)).toEqual(ok({ scanners: [], failure: null }));
    await handlers.startDiscovery(undefined);

    expect(startDiscovery).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('getDiscovery без поиска — пустой список без сбоя', async () => {
    const { handlers } = setup();
    expect(await handlers.getDiscovery(undefined)).toEqual(ok({ scanners: [], failure: null }));
  });

  it('пачка объявлений даёт одно событие с растущим номером', async () => {
    const { handlers, announce, discoveryEvents } = setup();
    await handlers.startDiscovery(undefined);
    const found: DiscoveryState = {
      scanners: [{ id: 'abcdef01-1', name: 'ET', address: '127.0.0.1', port: 9443, hasAdf: true }],
      failure: null,
    };

    announce(found);
    announce(found);
    announce(found);
    await Promise.resolve();
    announce(found);
    await Promise.resolve();

    expect(discoveryEvents).toEqual([1, 2]);
    expect(await handlers.getDiscovery(undefined)).toEqual(ok(found));
  });

  it('исключение получателя события не выходит из обработчика сокета', async () => {
    const service = setup().service;
    const commands = createCommands({
      service,
      openDataFolder: () => Promise.resolve(ok(undefined)),
      askSavePdfPath: () => Promise.resolve(null),
      defaultSaveFolder: 'C:\\Users\\Документы',
      askSaveFolder: () => Promise.resolve(null),
      onDiscoveryChanged: () => {
        throw new Error('окно закрыто');
      },
      startDiscovery: (options) => {
        queueMicrotask(() => options.onChange?.());
        return {
          state: () => ({ scanners: [], failure: null }),
          addressOf: () => null,
          stop: () => undefined,
        };
      },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await commands.handlers.startDiscovery(undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it('stopDiscovery останавливает поиск', async () => {
    const { handlers, stop } = setup();
    await handlers.startDiscovery(undefined);

    expect(await handlers.stopDiscovery(undefined)).toEqual(ok(undefined));
    expect(stop).toHaveBeenCalledOnce();
  });

  it('dispose при живом поиске останавливает его и отменяет подключение', async () => {
    const commands = setup();
    await commands.handlers.startDiscovery(undefined);

    commands.dispose();

    expect(commands.stop).toHaveBeenCalledOnce();
    expect(commands.cancel).toHaveBeenCalledOnce();
  });

  it('после остановки поиска найденное подключается по идентификатору', async () => {
    const { handlers, connect } = setup();
    await handlers.startDiscovery(undefined);
    await handlers.stopDiscovery(undefined);

    expect(await handlers.connectScanner({ kind: 'discovered', id: 'abcdef01-1' })).toEqual(
      ok(undefined),
    );
    expect(connect).toHaveBeenCalledOnce();
  });

  it('после dispose идентификатор прошлого поиска не принимается', async () => {
    const commands = setup();
    await commands.handlers.startDiscovery(undefined);
    commands.dispose();

    expect(
      await commands.handlers.connectScanner({ kind: 'discovered', id: 'abcdef01-1' }),
    ).toMatchObject({ ok: false, error: { code: 'invalidInput' } });
  });
});

describe('подключение сканера', () => {
  it('по адресу: разбор хоста, поля «Дополнительно» имеют приоритет, служба получает сканер', async () => {
    const { handlers, connect, service } = setup();

    const result = await handlers.connectScanner({
      kind: 'address',
      host: 'http://127.0.0.1:8080/x',
      scheme: 'https',
      port: 9443,
      basePath: 'eSCL/',
    });

    expect(result).toEqual(ok(undefined));
    expect(connect).toHaveBeenCalledExactlyOnceWith({
      scheme: 'https',
      host: '127.0.0.1',
      port: 9443,
      basePath: '/eSCL',
    });
    expect(service.useScanner).toHaveBeenCalledExactlyOnceWith(CONNECTED);
  });

  it('по адресу без «Дополнительно»: схема не названа, порт и путь по умолчанию', async () => {
    const { handlers, connect } = setup();

    await handlers.connectScanner({
      kind: 'address',
      host: 'scanner.local',
      scheme: null,
      port: null,
      basePath: null,
    });

    expect(connect).toHaveBeenCalledExactlyOnceWith({
      scheme: null,
      host: 'scanner.local',
      port: null,
      basePath: '/eSCL',
    });
  });

  it('по найденному: адрес берётся у поиска по идентификатору; чужой идентификатор — отказ', async () => {
    const { handlers, connect } = setup();
    await handlers.startDiscovery(undefined);

    expect(await handlers.connectScanner({ kind: 'discovered', id: 'abcdef01-1' })).toEqual(
      ok(undefined),
    );
    expect(connect).toHaveBeenCalledExactlyOnceWith({
      scheme: null,
      host: '127.0.0.1',
      port: 9443,
      basePath: '/eSCL',
    });
    expect(await handlers.connectScanner({ kind: 'discovered', id: 'abcdef01-2' })).toEqual(
      fail('invalidInput', { field: 'id', problem: 'unknown' }),
    );
  });

  it('мусор на входе — код неверного входа до обращения к сети', async () => {
    const { handlers, connect } = setup();
    for (const garbage of [
      undefined,
      {},
      { kind: 'address' },
      { kind: 'address', host: '', scheme: null, port: null, basePath: null },
      { kind: 'address', host: 'a', scheme: 'ftp', port: null, basePath: null },
      { kind: 'address', host: 'a', scheme: null, port: 70000, basePath: null },
      { kind: 'address', host: 'a', scheme: null, port: null, basePath: null, extra: true },
      { kind: 'discovered', id: '../x' },
      { kind: 'discovered', id: 'abcdef01-1', host: 'a' },
    ]) {
      expect(invalid(await handlers.connectScanner(garbage)), JSON.stringify(garbage)).toBe(true);
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it('негодный хост и путь — код неверного входа с именем поля', () => {
    expect(
      addressOf({ kind: 'address', host: 'user@host', scheme: null, port: null, basePath: null }),
    ).toEqual(fail('invalidInput', { field: 'host' }));
    expect(
      addressOf({ kind: 'address', host: 'host', scheme: null, port: null, basePath: '/a/../b' }),
    ).toEqual(fail('invalidInput', { field: 'basePath' }));
  });

  it('отказ подключения доходит кодом; служба сканер не получает', async () => {
    const { handlers, connect, service } = setup();
    connect.mockResolvedValueOnce(fail('scannerNoAdf'));

    const result = await handlers.connectScanner({
      kind: 'address',
      host: '127.0.0.1',
      scheme: null,
      port: null,
      basePath: null,
    });

    expect(result).toEqual(fail('scannerNoAdf'));
    expect(service.useScanner).not.toHaveBeenCalled();
  });

  it('во время прохода подключение отклоняется до обращения к сети', async () => {
    const { handlers, connect } = setup({
      ...EMPTY_SNAPSHOT,
      pass: {
        phase: 'scanning',
        resumed: false,
        expected: null,
        params: { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' },
        pages: 2,
      },
    });

    const result = await handlers.connectScanner({
      kind: 'address',
      host: '127.0.0.1',
      scheme: null,
      port: null,
      basePath: null,
    });

    expect(result).toEqual(fail('sessionConflict', { reason: 'passRunning' }));
    expect(connect).not.toHaveBeenCalled();
  });
});
