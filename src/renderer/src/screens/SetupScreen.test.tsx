import {
  ok,
  type Api,
  type ScanOptions,
  type ScanParams,
  type ScannerInfo,
  type ScannerState,
  type Snapshot,
} from '@shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { SetupScreen } from './SetupScreen';

const INFO: ScannerInfo = { name: 'ScanPro 200', scheme: 'https', host: '192.0.2.10', port: 443 };
const OPTIONS: ScanOptions = {
  colorModes: ['Grayscale8', 'RGB24'],
  resolutions: [100, 200, 300, 600],
  paperSizes: ['A4', 'Letter'],
};
const PARAMS: ScanParams = { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' };
const READY: ScannerState = { kind: 'ready', scanner: INFO, options: OPTIONS, params: PARAMS };

function makeSnapshot(scanner: ScannerState): Snapshot {
  return {
    blankMode: 'hide',
    straightenMode: 'auto',
    straightenProgress: null,
    seenHints: [],
    seq: 1,
    scanner,
    session: null,
    assembly: null,
    pass: null,
    canResume: false,
    canAccept: false,
    storage: { incompatible: false, unsaved: false },
    notices: [],
  };
}

function stubApi() {
  const setScanParams = vi.fn(() => Promise.resolve(ok(undefined)));
  const recheckScanner = vi.fn(() => Promise.resolve(ok(undefined)));
  const setBlankMode = vi.fn(() => Promise.resolve(ok(undefined)));
  const setStraightenMode = vi.fn(() => Promise.resolve(ok(undefined)));
  const api = {
    setScanParams,
    recheckScanner,
    setBlankMode,
    setStraightenMode,
  } as unknown as Api;
  vi.stubGlobal('api', api);
  return { setScanParams, recheckScanner, setBlankMode, setStraightenMode };
}

function renderSetup(
  scanner: ScannerState,
  overrides: Partial<Parameters<typeof SetupScreen>[0]> = {},
) {
  const props = {
    snapshot: makeSnapshot(scanner),
    launchFailure: null,
    onStart: vi.fn(),
    onOpenDevice: vi.fn(),
    ...overrides,
  };
  const view = render(<SetupScreen {...props} />);
  return { ...props, view };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SetupScreen', () => {
  it('варианты разрешения равны набору из снимка, а не константам', () => {
    stubApi();
    renderSetup(READY);

    const group = screen.getByRole('radiogroup', { name: 'Разрешение' });
    const labels = within(group)
      .getAllByRole('radio')
      .map((segment) => segment.textContent);
    expect(labels).toEqual(['100 dpi', '200 dpi', '300 dpi', '600 dpi']);
  });

  it('смена параметра уходит командой и переживает перерисовку', () => {
    const { setScanParams } = stubApi();
    const { view } = renderSetup(READY);

    fireEvent.click(screen.getByRole('radio', { name: '600 dpi' }));
    expect(setScanParams).toHaveBeenCalledExactlyOnceWith({ ...PARAMS, resolution: 600 });

    view.rerender(
      <SetupScreen
        snapshot={makeSnapshot({ ...READY, params: { ...PARAMS, resolution: 600 } })}
        launchFailure={null}
        onStart={vi.fn()}
        onOpenDevice={vi.fn()}
      />,
    );
    expect(screen.getByRole('radio', { name: '600 dpi' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('запуск без сканера открывает модалку и не начинает проход', () => {
    stubApi();
    const { onStart, onOpenDevice } = renderSetup({ kind: 'none' });

    fireEvent.click(screen.getByRole('button', { name: 'Сканировать лицевые стороны' }));
    expect(onOpenDevice).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('готовый сканер: запуск зовёт onStart', () => {
    stubApi();
    const { onStart } = renderSetup(READY);

    fireEvent.click(screen.getByRole('button', { name: 'Сканировать лицевые стороны' }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('сканер не отвечает: «Повторить» зовёт проверку, «Сменить» — модалку, ряды недоступны', () => {
    const { recheckScanner } = stubApi();
    const { onOpenDevice } = renderSetup({
      kind: 'unreachable',
      scanner: INFO,
      error: { code: 'scannerUnreachable', details: { reason: 'timeout' } },
      params: PARAMS,
    });

    expect(screen.getByRole('status').textContent).toBe('не отвечает');
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(recheckScanner).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Сменить' }));
    expect(onOpenDevice).toHaveBeenCalledTimes(1);

    // Ряды «Пустые обороты» и «Выравнивание» — настройки приложения, не устройства: доступны и
    // без сканера (M4; M6).
    const app = [
      screen.getByRole('radiogroup', { name: 'Пустые обороты' }),
      screen.getByRole('radiogroup', { name: 'Выравнивание' }),
    ];
    for (const group of screen.getAllByRole('radiogroup')) {
      expect(group.getAttribute('aria-disabled')).toBe(app.includes(group) ? null : 'true');
    }
  });

  it('проверяется: «Сменить» недоступна, ряды показывают значения, но недоступны', () => {
    stubApi();
    renderSetup({ kind: 'checking', scanner: INFO, params: PARAMS });

    expect(screen.getByRole('status').textContent).toBe('проверяем…');
    const change = screen.getByRole('button', { name: 'Сменить' });
    expect((change as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('radio', { name: 'Оттенки серого' })).toBeDefined();
  });

  it('по адресу другое устройство: «Подключить заново» открывает модалку с адресом', () => {
    stubApi();
    const { onOpenDevice } = renderSetup({
      kind: 'otherDevice',
      scanner: INFO,
      error: null,
      params: PARAMS,
    });

    const status = screen.getByRole('status');
    expect(status.textContent).toBe('по адресу другое устройство');
    expect(status.getAttribute('title')).toBe(
      'По этому адресу отвечает другой сканер, не тот, что был запомнен',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Подключить заново' }));
    expect(onOpenDevice).toHaveBeenCalledExactlyOnceWith('192.0.2.10:443');
  });

  it('схема HTTP помечена бейджем с пояснением', () => {
    stubApi();
    renderSetup({ ...READY, scanner: { ...INFO, scheme: 'http' } });

    const badge = screen.getByText('HTTP');
    expect(badge.getAttribute('title')).toBe('Соединение со сканером не шифруется');
  });

  it('при HTTPS бейджа нет', () => {
    stubApi();
    renderSetup(READY);
    expect(screen.queryByText('HTTP')).toBeNull();
  });

  it('«Сбросить параметры» шлёт дефолты KTD-13 против вариантов устройства', () => {
    const { setScanParams } = stubApi();
    renderSetup({
      ...READY,
      params: { colorMode: 'RGB24', resolution: 600, paperSize: 'Letter' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Сбросить параметры' }));
    expect(setScanParams).toHaveBeenCalledExactlyOnceWith(PARAMS);
  });

  it('ряд «Пустые обороты» показывает режим из снимка, клик шлёт команду, доступен без сканера (M4, R1)', () => {
    const { setBlankMode, setScanParams } = stubApi();
    const { view } = renderSetup({ kind: 'none' });

    const group = screen.getByRole('radiogroup', { name: 'Пустые обороты' });
    expect(group.getAttribute('aria-disabled')).toBeNull();
    expect(
      within(group).getByRole('radio', { name: 'Скрывать' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(within(group).getByRole('radio', { name: 'Помечать' }).getAttribute('title')).toBe(
      'останутся, но с меткой',
    );

    fireEvent.click(within(group).getByRole('radio', { name: 'Оставлять' }));
    expect(setBlankMode).toHaveBeenCalledExactlyOnceWith('keep');
    expect(setScanParams).not.toHaveBeenCalled();

    view.rerender(
      <SetupScreen
        snapshot={{ ...makeSnapshot({ kind: 'none' }), blankMode: 'keep' }}
        launchFailure={null}
        onStart={vi.fn()}
        onOpenDevice={vi.fn()}
      />,
    );
    expect(
      within(group).getByRole('radio', { name: 'Оставлять' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('«Сбросить параметры» возвращает режим пустых оборотов к «Скрывать» (M4, R1) и выравнивание к «Выравнивать» (M6, R13)', () => {
    const { setBlankMode, setStraightenMode } = stubApi();
    renderSetup(READY, {
      snapshot: { ...makeSnapshot(READY), blankMode: 'mark', straightenMode: 'off' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Сбросить параметры' }));
    expect(setBlankMode).toHaveBeenCalledExactlyOnceWith('hide');
    expect(setStraightenMode).toHaveBeenCalledExactlyOnceWith('auto');
  });

  it('ряд «Выравнивание» показывает режим из снимка, клик шлёт команду, доступен без сканера (M6, R13)', () => {
    const { setStraightenMode, setScanParams } = stubApi();
    const { view } = renderSetup({ kind: 'none' });

    const group = screen.getByRole('radiogroup', { name: 'Выравнивание' });
    expect(group.getAttribute('aria-disabled')).toBeNull();
    expect(
      within(group).getByRole('radio', { name: 'Выравнивать' }).getAttribute('aria-checked'),
    ).toBe('true');
    // Подсказка говорит, что смена подействует со следующего сканирования (handoff M6).
    expect(within(group).getByRole('radio', { name: 'Не трогать' }).getAttribute('title')).toMatch(
      /^страницы останутся как со сканера\. .*со следующего сканирования$/u,
    );

    fireEvent.click(within(group).getByRole('radio', { name: 'Не трогать' }));
    expect(setStraightenMode).toHaveBeenCalledExactlyOnceWith('off');
    expect(setScanParams).not.toHaveBeenCalled();

    view.rerender(
      <SetupScreen
        snapshot={{ ...makeSnapshot({ kind: 'none' }), straightenMode: 'off' }}
        launchFailure={null}
        onStart={vi.fn()}
        onOpenDevice={vi.fn()}
      />,
    );
    expect(
      within(group).getByRole('radio', { name: 'Не трогать' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('отказ «нет бумаги» — плашка-предупреждение текстом кода, без префикса', () => {
    stubApi();
    renderSetup(READY, { launchFailure: { code: 'scanNoPaper' } });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(
      'В лотке нет бумаги. Положите листы в автоподатчик и запустите ещё раз.',
    );
    expect(alert.className).toContain('notice--warning');
  });

  it('смена сертификата — плашка-отказ с кнопкой «Подключить заново»', () => {
    stubApi();
    const { onOpenDevice } = renderSetup(READY, {
      launchFailure: { code: 'scannerCertificateChanged' },
    });

    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('notice--danger');
    expect(alert.textContent).toContain('Проход не начался: по адресу сканера теперь отвечает');
    fireEvent.click(within(alert).getByRole('button', { name: 'Подключить заново' }));
    expect(onOpenDevice).toHaveBeenCalledExactlyOnceWith('192.0.2.10:443');
  });

  it('недоступные ряды показывают запомненные параметры из снимка, а не дефолты', () => {
    stubApi();
    renderSetup({
      kind: 'unreachable',
      scanner: INFO,
      error: { code: 'scannerUnreachable' },
      params: { colorMode: 'RGB24', resolution: 600, paperSize: 'Letter' },
    });

    expect(screen.getByRole('radio', { name: '600 dpi' })).toBeDefined();
    expect(screen.getByRole('radio', { name: 'Цвет' })).toBeDefined();
    expect(screen.queryByRole('radio', { name: '300 dpi' })).toBeNull();
  });

  it('после потери сканера ряды держат варианты последнего подтверждения', () => {
    stubApi();
    const { view } = renderSetup(READY);

    view.rerender(
      <SetupScreen
        snapshot={makeSnapshot({
          kind: 'unreachable',
          scanner: INFO,
          error: { code: 'scannerUnreachable' },
          params: PARAMS,
        })}
        launchFailure={null}
        onStart={vi.fn()}
        onOpenDevice={vi.fn()}
      />,
    );

    // Полный набор capabilities прошлого подтверждения, недоступный.
    const group = screen.getByRole('radiogroup', { name: 'Разрешение' });
    expect(within(group).getAllByRole('radio').length).toBe(4);
    expect(group.getAttribute('aria-disabled')).toBe('true');
  });
});
