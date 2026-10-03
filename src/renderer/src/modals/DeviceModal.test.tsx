import {
  fail,
  ok,
  type Api,
  type CommandResult,
  type DiscoveredScanner,
  type DiscoveryState,
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

function stubApi(state: DiscoveryState = FOUND) {
  const connects: ((result: CommandResult<'connectScanner'>) => void)[] = [];
  const connectScanner = vi.fn(
    () =>
      new Promise<CommandResult<'connectScanner'>>((resolve) => {
        connects.push(resolve);
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
    onDiscoveryChanged: vi.fn(() => () => undefined),
  } as unknown as Api;
  vi.stubGlobal('api', api);
  return {
    connectScanner,
    stopDiscovery,
    cancelConnect,
    resolveConnect: (index: number, result: CommandResult<'connectScanner'>): void => {
      connects[index]?.(result);
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

    resolveConnect(0, ok(undefined));
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
    [fail('notEsclScanner'), /не отвечает сканер/i],
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

    resolveConnect(0, ok(undefined));
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
});
