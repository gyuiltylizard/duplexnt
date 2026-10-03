import {
  BRIDGE_CHANNELS,
  fail,
  ok,
  type BridgeCommand,
  type DiscoveryState,
  type Result,
  type Snapshot,
} from '@shared';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectedScanner, Connector, ScannerAddress } from '../escl/connect';
import type { Discovery } from '../discovery/mdns';
import type { PassService } from '../scan/pass-service';
import { addressOf, createCommands } from './handlers';

// Обработчики команд моста (план M1, U18, KTD-39): верный вход — успех в конверте, мусор — код
// неверного входа, доменный отказ службы — код, а не исключение. Служба, поиск и подключение —
// подставные: сам проход проверяется против эмулятора.

const EMPTY_SNAPSHOT: Snapshot = {
  seq: 0,
  scanner: { kind: 'none' },
  session: null,
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
  const discoveryEvents: number[] = [];
  const commands = createCommands({
    service,
    openDataFolder,
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
      pass: { phase: 'scanning', resumed: false, pages: 2 },
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
