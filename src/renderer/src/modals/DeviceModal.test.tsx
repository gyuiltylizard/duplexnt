import {
  fail,
  ok,
  type Api,
  type CommandResult,
  type ConnectScannerOutcome,
  type DiscoveredScanner,
  type DiscoveryState,
  type ScannerInfo,
} from '@shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { DeviceModal, EMPTY_SEARCH_DELAY_MS } from './DeviceModal';

const SCANNER: DiscoveredScanner = {
  id: 'abcdef01-1',
  name: 'ScanPro 200',
  address: '192.0.2.10',
  port: 443,
  hasAdf: true,
};
const NO_ADF: DiscoveredScanner = {
  id: 'abcdef01-2',
  name: 'Epson V39',
  address: '192.0.2.11',
  port: 443,
  hasAdf: false,
};
const FOUND: DiscoveryState = { scanners: [SCANNER, NO_ADF], failure: null };
/** Ответ `connectScanner` — подключённый сканер; тост берёт имя из него (B-17). */
const CONNECTED_INFO = {
  name: 'ScanPro 200',
  scheme: 'https',
  host: '192.0.2.10',
  port: 443,
} as const;

function stubApi(state: DiscoveryState = FOUND) {
  const connects: ((result: CommandResult<'connectScanner'>) => void)[] = [];
  const connectScanner = vi.fn(
    () =>
      new Promise<CommandResult<'connectScanner'>>((resolve) => {
        connects.push(resolve);
      }),
  );
  const confirms: ((result: CommandResult<'confirmScannerChange'>) => void)[] = [];
  const confirmScannerChange = vi.fn(
    () =>
      new Promise<CommandResult<'confirmScannerChange'>>((resolve) => {
        confirms.push(resolve);
      }),
  );
  const stopDiscovery = vi.fn(() => Promise.resolve(ok(undefined)));
  const cancelConnect = vi.fn(() => Promise.resolve(ok(undefined)));
  const api = {
    startDiscovery: vi.fn(() => Promise.resolve(ok(state))),
    getDiscovery: vi.fn(() => Promise.resolve(ok(state))),
    stopDiscovery,
    cancelConnect,
    connectScanner,
    confirmScannerChange,
    onDiscoveryChanged: vi.fn(() => () => undefined),
  } as unknown as Api;
  vi.stubGlobal('api', api);
  return {
    connectScanner,
    confirmScannerChange,
    stopDiscovery,
    cancelConnect,
    resolveConnect: (index: number, result: CommandResult<'connectScanner'>): void => {
      connects[index]?.(result);
    },
    resolveConfirm: (index: number, result: CommandResult<'confirmScannerChange'>): void => {
      confirms[index]?.(result);
    },
  };
}

const flush = async (): Promise<void> =>
  act(async () => {
    await Promise.resolve();
  });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('DeviceModal', () => {
  it('выбор устройства и «Подключить» подключают по id, зовут тост и закрытие', async () => {
    const { connectScanner, resolveConnect } = stubApi();
    const onClose = vi.fn();
    const onConnected = vi.fn();
    render(<DeviceModal onClose={onClose} onConnected={onConnected} />);
    await flush();

    fireEvent.click(screen.getByText('ScanPro 200'));
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    expect(connectScanner).toHaveBeenCalledExactlyOnceWith({ kind: 'discovered', id: SCANNER.id });

    resolveConnect(0, ok({ kind: 'connected' as const, scanner: CONNECTED_INFO }));
    await flush();
    expect(onConnected).toHaveBeenCalledExactlyOnceWith('ScanPro 200');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ввод адреса снимает выбор в списке, а выбор очищает поле', async () => {
    stubApi();
    render(<DeviceModal onClose={vi.fn()} onConnected={vi.fn()} />);
    await flush();

    const option = screen.getByRole('option', { name: /ScanPro 200/ });
    fireEvent.click(option);
    expect(option.getAttribute('aria-selected')).toBe('true');

    const address = screen.getByPlaceholderText('адрес сканера в сети');
    fireEvent.change(address, { target: { value: '192.0.2.50' } });
    expect(option.getAttribute('aria-selected')).toBe('false');

    fireEvent.click(option);
    expect(option.getAttribute('aria-selected')).toBe('true');
    expect((address as HTMLInputElement).value).toBe('');
  });

  it('устройство без автоподачи приглушено и не выбирается', async () => {
    const { connectScanner } = stubApi();
    render(<DeviceModal onClose={vi.fn()} onConnected={vi.fn()} />);
    await flush();

    const option = screen.getByRole('option', { name: /Epson V39/ });
    expect(option.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(option);
    expect(option.getAttribute('aria-selected')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    expect(connectScanner).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(
      'Выберите сканер в списке или введите адрес',
    );
  });

  it('адрес с полями «Дополнительно» уходит как есть; нетронутая схема — null', async () => {
    const { connectScanner } = stubApi({ scanners: [], failure: null });
    render(<DeviceModal onClose={vi.fn()} onConnected={vi.fn()} />);
    await flush();

    fireEvent.change(screen.getByPlaceholderText('адрес сканера в сети'), {
      target: { value: '192.0.2.50:9443' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    expect(connectScanner).toHaveBeenLastCalledWith({
      kind: 'address',
      host: '192.0.2.50:9443',
      scheme: null,
      port: null,
      basePath: null,
    });
  });

  it('поля «Дополнительно» имеют приоритет: схема, порт и путь уходят заполненными', async () => {
    const { connectScanner } = stubApi({ scanners: [], failure: null });
    render(<DeviceModal onClose={vi.fn()} onConnected={vi.fn()} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /Дополнительно/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'HTTP' }));
    fireEvent.change(screen.getByPlaceholderText('80'), { target: { value: '8080' } });
    fireEvent.change(screen.getByPlaceholderText('/eSCL'), { target: { value: '/custom' } });
    fireEvent.change(screen.getByPlaceholderText('адрес сканера в сети'), {
      target: { value: 'scanner.local' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));

    expect(connectScanner).toHaveBeenLastCalledWith({
      kind: 'address',
      host: 'scanner.local',
      scheme: 'http',
      port: 8080,
      basePath: '/custom',
    });
  });

  it.each([
    [fail('scannerUnreachable', { reason: 'timeout' }), /сканер не отвечает/i],
    [fail('notEsclScanner'), /не умеет сканировать по сети/i],
    [fail('scannerNoAdf'), /нет автоподатчика/i],
    [fail('scannerNoJpeg'), /формате JPEG/i],
    [fail('invalidInput', { field: 'host' }), /адрес не подходит/i],
  ])('отказ подключения показан своим текстом: %j', async (result, expected) => {
    const { resolveConnect } = stubApi();
    render(<DeviceModal onClose={vi.fn()} onConnected={vi.fn()} />);
    await flush();

    fireEvent.click(screen.getByText('ScanPro 200'));
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    resolveConnect(0, result);
    await flush();

    expect(screen.getByRole('alert').textContent).toMatch(expected);
    // Кнопка снова «Подключить», выбор не сброшен.
    expect(screen.getByRole('button', { name: 'Подключить' })).toBeDefined();
    expect(screen.getByRole('option', { name: /ScanPro 200/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('пока подключение идёт: «Подключаем…» недоступна, тело приглушено, фокус на «Отмена»', async () => {
    stubApi();
    render(<DeviceModal onClose={vi.fn()} onConnected={vi.fn()} />);
    await flush();

    fireEvent.click(screen.getByText('ScanPro 200'));
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));

    const busyButton = screen.getByRole('button', { name: 'Подключаем…' });
    expect((busyButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('Подключаемся к ScanPro 200…');
    expect(document.activeElement?.textContent).toBe('Отмена');
  });

  it('B-11: Esc — как «Отмена»: и с полем адреса в фокусе, и во время подключения', async () => {
    stubApi();
    const onClose = vi.fn();
    const view = render(<DeviceModal onClose={onClose} onConnected={vi.fn()} />);
    await flush();

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    view.unmount();
    const onCloseBusy = vi.fn();
    render(<DeviceModal onClose={onCloseBusy} onConnected={vi.fn()} />);
    await flush();
    fireEvent.click(screen.getByText('ScanPro 200'));
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Отмена' }), { key: 'Escape' });
    expect(onCloseBusy).toHaveBeenCalledTimes(1);
  });

  it('закрытие останавливает поиск и отменяет идущее подключение', async () => {
    const { stopDiscovery, cancelConnect } = stubApi();
    const view = render(<DeviceModal onClose={vi.fn()} onConnected={vi.fn()} />);
    await flush();

    view.unmount();
    expect(stopDiscovery).toHaveBeenCalledTimes(1);
    expect(cancelConnect).toHaveBeenCalledTimes(1);
  });

  it('позднее завершение отменённого подключения ничего не меняет', async () => {
    const { resolveConnect } = stubApi();
    const onClose = vi.fn();
    const onConnected = vi.fn();
    const view = render(<DeviceModal onClose={onClose} onConnected={onConnected} />);
    await flush();

    fireEvent.click(screen.getByText('ScanPro 200'));
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    view.unmount();

    resolveConnect(0, ok({ kind: 'connected' as const, scanner: CONNECTED_INFO }));
    await flush();
    expect(onConnected).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('пустой результат после ожидания показывает «ничего не нашлось», поиск продолжается', async () => {
    vi.useFakeTimers();
    stubApi({ scanners: [], failure: null });
    render(<DeviceModal onClose={vi.fn()} onConnected={vi.fn()} />);
    await flush();

    expect(screen.queryByText(/Пока ничего не нашлось/)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(EMPTY_SEARCH_DELAY_MS);
    });

    expect(screen.getByText(/Пока ничего не нашлось/)).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe('Идёт поиск сканеров в сети…');
  });

  it('сбой сети при поиске: текст в области списка, скелетонов нет, адрес работает', async () => {
    const { connectScanner } = stubApi({ scanners: [], failure: 'noNetwork' });
    const view = render(<DeviceModal onClose={vi.fn()} onConnected={vi.fn()} />);
    await flush();

    expect(screen.getByRole('alert').textContent).toMatch(/Нет подключения к сети/);
    expect(view.container.querySelector('.device-skeleton')).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('адрес сканера в сети'), {
      target: { value: '192.0.2.50' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    expect(connectScanner).toHaveBeenCalledTimes(1);
  });

  it('Tab не выходит за пределы модалки', async () => {
    stubApi();
    render(<DeviceModal onClose={vi.fn()} onConnected={vi.fn()} />);
    await flush();

    const connect = screen.getByRole('button', { name: 'Подключить' });
    connect.focus();
    fireEvent.keyDown(connect, { key: 'Tab' });
    expect(document.activeElement?.getAttribute('role')).toBe('option');
  });

  it('S4: открытие с адресом — поле заполнено, «Дополнительно» раскрыто, уходит kind address', async () => {
    const { connectScanner } = stubApi({ scanners: [], failure: null });
    render(<DeviceModal initialAddress="192.0.2.10:443" onClose={vi.fn()} onConnected={vi.fn()} />);
    await flush();

    const input = screen.getByPlaceholderText('адрес сканера в сети');
    expect((input as HTMLInputElement).value).toBe('192.0.2.10:443');
    expect(
      screen.getByRole('button', { name: /Дополнительно/ }).getAttribute('aria-expanded'),
    ).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    expect(connectScanner).toHaveBeenCalledExactlyOnceWith({
      kind: 'address',
      host: '192.0.2.10:443',
      scheme: null,
      port: null,
      basePath: null,
    });
  });

  it('S11: «canceled» не даёт текста, кнопка снова «Подключить»', async () => {
    const { resolveConnect } = stubApi();
    render(<DeviceModal onClose={vi.fn()} onConnected={vi.fn()} />);
    await flush();

    fireEvent.click(await screen.findByText('ScanPro 200'));
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    resolveConnect(0, fail('canceled'));
    await flush();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Подключить' })).toBeDefined();
  });

  it('S9: найденный без имени — «Сканер без имени», адрес и порт видны', async () => {
    stubApi({
      scanners: [{ id: 'abcdef01-3', name: null, address: '192.0.2.12', port: 8080, hasAdf: true }],
      failure: null,
    });
    render(<DeviceModal onClose={vi.fn()} onConnected={vi.fn()} />);
    await flush();

    expect(screen.getByText('Сканер без имени')).toBeDefined();
    expect(screen.getByText('192.0.2.12:8080')).toBeDefined();
  });

  it('B-17: после ручного ввода тост получает имя сканера из ответа ядра, не введённый адрес', async () => {
    const { resolveConnect } = stubApi({ scanners: [], failure: null });
    const onConnected = vi.fn();
    render(<DeviceModal onClose={vi.fn()} onConnected={onConnected} />);
    await flush();

    fireEvent.change(screen.getByPlaceholderText('адрес сканера в сети'), {
      target: { value: '192.0.2.10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    resolveConnect(0, ok({ kind: 'connected' as const, scanner: CONNECTED_INFO }));
    await flush();

    expect(onConnected).toHaveBeenCalledExactlyOnceWith('ScanPro 200');
  });

  it('B-17: сканер без имени в ответе — тост с введённым адресом', async () => {
    const { resolveConnect } = stubApi({ scanners: [], failure: null });
    const onConnected = vi.fn();
    render(<DeviceModal onClose={vi.fn()} onConnected={onConnected} />);
    await flush();

    fireEvent.change(screen.getByPlaceholderText('адрес сканера в сети'), {
      target: { value: '192.0.2.10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    resolveConnect(
      0,
      ok({ kind: 'connected' as const, scanner: { ...CONNECTED_INFO, name: null } }),
    );
    await flush();

    expect(onConnected).toHaveBeenCalledExactlyOnceWith('192.0.2.10');
  });

  it.each(['70000', '0'])(
    'B-17: порт %s вне 1–65535 — текст про порт в строке статуса, команда не уходит',
    async (value) => {
      const { connectScanner } = stubApi({ scanners: [], failure: null });
      render(<DeviceModal onClose={vi.fn()} onConnected={vi.fn()} />);
      await flush();

      fireEvent.click(screen.getByRole('button', { name: /Дополнительно/ }));
      fireEvent.change(screen.getByPlaceholderText('443'), { target: { value } });
      fireEvent.change(screen.getByPlaceholderText('адрес сканера в сети'), {
        target: { value: 'scanner.local' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));

      expect(screen.getByRole('alert').textContent).toBe('Порт должен быть от 1 до 65535.');
      expect(connectScanner).not.toHaveBeenCalled();
    },
  );

  it('B-17: порт 65535 — крайнее допустимое, команда уходит', async () => {
    const { connectScanner } = stubApi({ scanners: [], failure: null });
    render(<DeviceModal onClose={vi.fn()} onConnected={vi.fn()} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /Дополнительно/ }));
    fireEvent.change(screen.getByPlaceholderText('443'), { target: { value: '65535' } });
    fireEvent.change(screen.getByPlaceholderText('адрес сканера в сети'), {
      target: { value: 'scanner.local' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));

    expect(connectScanner).toHaveBeenCalledOnce();
    expect(connectScanner).toHaveBeenLastCalledWith(expect.objectContaining({ port: 65535 }));
  });
});

// --- Шаг подтверждения смены устройства (B-29; handoff scanner-change, вариант 1b) -----------

const REMEMBERED_INFO: ScannerInfo = {
  name: 'ScanPro 100',
  scheme: 'https',
  host: '192.0.2.10',
  port: 443,
};
const CONFIRMATION: Extract<ConnectScannerOutcome, { kind: 'confirmation' }> = {
  kind: 'confirmation',
  token: 'ab'.repeat(16),
  scanner: CONNECTED_INFO,
  remembered: REMEMBERED_INFO,
  interruptedPass: false,
  awaitingBacks: false,
};

/** Модалка с адресом в поле, «Подключить» нажата, ядро ответило «нужно подтверждение». */
async function openStep(
  confirmation: typeof CONFIRMATION = CONFIRMATION,
  props: { onClose?: () => void; onConnected?: (label: string, saved?: boolean) => void } = {},
) {
  const stub = stubApi();
  const onClose = props.onClose ?? vi.fn();
  const onConnected = props.onConnected ?? vi.fn();
  render(
    <DeviceModal initialAddress="192.0.2.10:443" onClose={onClose} onConnected={onConnected} />,
  );
  await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
  await flush();
  stub.resolveConnect(0, ok(confirmation));
  await flush();
  return { ...stub, onClose, onConnected };
}

describe('DeviceModal — шаг подтверждения смены устройства', () => {
  it('ответ «нужно подтверждение» открывает шаг: карточка, список скрыт, поле недоступно, фокус на «Отмене»', async () => {
    await openStep();

    const step = screen.getByRole('alertdialog', {
      name: 'По этому адресу отвечает другое устройство',
    });
    expect(step.textContent).toContain('ScanPro 200');
    expect(step.textContent).toContain('192.0.2.10:443');
    expect(step.textContent).toContain('ЗАМЕНИТ');
    expect(step.textContent).toContain('сканер ScanPro 100');
    expect(step.textContent).not.toContain('продолжить будет нельзя');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('АДРЕС ВРУЧНУЮ').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('АДРЕС ВРУЧНУЮ').value).toBe('192.0.2.10:443');
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Подключить это устройство' }).disabled,
    ).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Отмена' }));
    expect(screen.queryByRole('status')?.textContent ?? '').toBe('');
  });

  it('безымянное устройство — «Сканер без имени»; имя запомненного без имени — его хост', async () => {
    await openStep({
      ...CONFIRMATION,
      scanner: { ...CONNECTED_INFO, name: null },
      remembered: { ...REMEMBERED_INFO, name: null },
    });

    const step = screen.getByRole('alertdialog');
    expect(step.textContent).toContain('Сканер без имени');
    expect(step.textContent).toContain('сканер 192.0.2.10');
  });

  it.each([
    [
      'прерванный проход',
      { interruptedPass: true, awaitingBacks: false },
      'продолжить будет нельзя',
    ],
    [
      'flip: ждём обороты',
      { interruptedPass: false, awaitingBacks: true },
      'соберётся с двух устройств',
    ],
  ])('строка последствий: %s', async (_name, consequences, expected) => {
    await openStep({ ...CONFIRMATION, ...consequences });

    const step = screen.getByRole('alertdialog');
    expect(step.textContent).toContain(expected);
    expect(step.getAttribute('aria-describedby')).toContain('device-confirm-cost');
  });

  it('подтверждение шлёт только токен; успех закрывает модалку и зовёт тост с именем', async () => {
    const { confirmScannerChange, resolveConfirm, onClose, onConnected } = await openStep();

    fireEvent.click(screen.getByRole('button', { name: 'Подключить это устройство' }));
    await flush();

    expect(confirmScannerChange).toHaveBeenCalledExactlyOnceWith({ token: 'ab'.repeat(16) });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Подключаем…' }).disabled).toBe(
      true,
    );
    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('Подключаемся к ScanPro 200…');

    resolveConfirm(0, ok({ scanner: CONNECTED_INFO, settingsSaved: true }));
    await flush();

    expect(onConnected).toHaveBeenCalledExactlyOnceWith('ScanPro 200', true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('настройки не записались — модалка закрывается, тост с предупреждением (settingsSaved ложь)', async () => {
    const { resolveConfirm, onClose, onConnected } = await openStep();

    fireEvent.click(screen.getByRole('button', { name: 'Подключить это устройство' }));
    await flush();
    resolveConfirm(0, ok({ scanner: CONNECTED_INFO, settingsSaved: false }));
    await flush();

    expect(onConnected).toHaveBeenCalledExactlyOnceWith('ScanPro 200', false);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('двойной клик по подтверждению — одно подтверждение', async () => {
    const { confirmScannerChange } = await openStep();

    const button = screen.getByRole('button', { name: 'Подключить это устройство' });
    fireEvent.click(button);
    fireEvent.click(button);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Подключаем…' }));
    await flush();

    expect(confirmScannerChange).toHaveBeenCalledOnce();
  });

  it('«Отмена» в шаге возвращает к вводу с прежним адресом, гасит пробу, фокус в поле', async () => {
    const { cancelConnect, onClose } = await openStep();

    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    await flush();

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('listbox')).not.toBeNull();
    const address = screen.getByLabelText<HTMLInputElement>('АДРЕС ВРУЧНУЮ');
    expect(address.disabled).toBe(false);
    expect(address.value).toBe('192.0.2.10:443');
    expect(document.activeElement).toBe(address);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Подключить' }).disabled).toBe(
      false,
    );
    expect(cancelConnect).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Esc в шаге закрывает модалку; размонтирование гасит пробу', async () => {
    const { cancelConnect, onClose } = await openStep();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();

    cleanup();
    await flush();
    expect(cancelConnect).toHaveBeenCalled();
  });

  it.each([
    ['проба устарела', fail('scannerChangeStale', { reason: 'token' }), /пока вы решали/],
    ['идёт сканирование', fail('sessionConflict', { reason: 'passRunning' }), /идёт сканирование/],
    ['иной отказ', fail('scannerUnreachable', { reason: 'timeout' }), /^Не удалось подключиться: /],
  ])('отказ подтверждения — %s: свой текст и возврат к вводу', async (_name, error, expected) => {
    const { resolveConfirm, onClose } = await openStep();

    fireEvent.click(screen.getByRole('button', { name: 'Подключить это устройство' }));
    await flush();
    resolveConfirm(0, error);
    await flush();

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(expected);
    expect(screen.getByLabelText<HTMLInputElement>('АДРЕС ВРУЧНУЮ').value).toBe('192.0.2.10:443');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Подключить' }).disabled).toBe(
      false,
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('новая проба после отказа снова открывает шаг с новым токеном', async () => {
    const { resolveConnect, resolveConfirm, confirmScannerChange } = await openStep();
    fireEvent.click(screen.getByRole('button', { name: 'Подключить это устройство' }));
    await flush();
    resolveConfirm(0, fail('scannerChangeStale', { reason: 'token' }));
    await flush();

    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    await flush();
    resolveConnect(1, ok({ ...CONFIRMATION, token: 'cd'.repeat(16) }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Подключить это устройство' }));
    await flush();

    expect(confirmScannerChange).toHaveBeenLastCalledWith({ token: 'cd'.repeat(16) });
  });
});
