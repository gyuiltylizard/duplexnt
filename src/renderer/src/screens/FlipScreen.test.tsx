import {
  EMPTY_EDITS,
  fail,
  ok,
  type Api,
  type AssemblyReport,
  type PassProgress,
  type Snapshot,
} from '@shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { NO_EDITS_ASSEMBLY } from '../state/assembly-fixture';
import { FlipScreen } from './FlipScreen';

const PARAMS = { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' } as const;

function report(fronts: number): AssemblyReport {
  return {
    fronts,
    backs: 0,
    pairs: 0,
    unpairedSheets: [],
    extraBacks: 0,
    backsState: null,
    backsDeclined: false,
    mismatch: false,
  };
}

function makeSnapshot(fronts: number): Snapshot {
  return {
    seq: 1,
    scanner: { kind: 'none' },
    session: {
      id: 'session.x',
      backsDeclined: false,
      saved: false,
      edits: EMPTY_EDITS,
      passes: [
        {
          number: 1,
          state: 'completed',
          paramsKnown: true,
          scanner: null,
          kind: 'fronts',
          after: null,
          rotate180: false,
          pages: Array.from({ length: fronts }, (_, index) => ({
            key: `p01-s01-${String(index + 1).padStart(4, '0')}`,
            number: index + 1,
            lost: false,
          })),
        },
      ],
    },
    assembly: { ...NO_EDITS_ASSEMBLY, report: report(fronts) },
    pass: null,
    canResume: false,
    canAccept: false,
    storage: { incompatible: false, unsaved: false },
    notices: [],
  };
}

function stubApi(overrides: Partial<Record<keyof Api, unknown>> = {}) {
  const declineBacks = vi.fn(() => Promise.resolve(ok(undefined)));
  const api = { declineBacks, ...overrides } as unknown as Api;
  vi.stubGlobal('api', api);
  return { declineBacks };
}

function renderFlip(overrides: Partial<Parameters<typeof FlipScreen>[0]> = {}) {
  const props = {
    snapshot: makeSnapshot(12),
    pass: null,
    launchFailure: null,
    onStart: vi.fn(),
    onOpenDevice: vi.fn(),
    ...overrides,
  };
  const view = render(<FlipScreen {...props} />);
  return { ...props, view };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('FlipScreen', () => {
  it('кикер несёт число листов лицевого прохода из отчёта сборки', () => {
    stubApi();
    renderFlip();

    expect(screen.getByText('ШАГ 2 ИЗ 3 · ЛИЦА ГОТОВЫ: 12 листов')).toBeDefined();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Разверните листы на 180° — все разом',
    );
  });

  it.each([
    [1, 'ШАГ 2 ИЗ 3 · ЛИЦА ГОТОВЫ: 1 лист'],
    [3, 'ШАГ 2 ИЗ 3 · ЛИЦА ГОТОВЫ: 3 листа'],
    [21, 'ШАГ 2 ИЗ 3 · ЛИЦА ГОТОВЫ: 21 лист'],
  ])('плюрализация кикера: %i', (fronts, expected) => {
    stubApi();
    renderFlip({ snapshot: makeSnapshot(fronts) });

    expect(screen.getByText(expected)).toBeDefined();
  });

  it('чеклист из четырёх пунктов, первый — про входной лоток', () => {
    stubApi();
    renderFlip();

    const items = screen.getAllByRole('listitem');
    expect(items.length).toBe(4);
    expect(items[0]?.textContent).toContain('Проверьте входной лоток');
  });

  it('«Листы в лотке — сканировать обороты» зовёт onStart', () => {
    stubApi();
    const { onStart } = renderFlip();

    fireEvent.click(screen.getByRole('button', { name: 'Листы в лотке — сканировать обороты' }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('«Обороты не нужны» шлёт declineBacks', () => {
    const { declineBacks } = stubApi();
    renderFlip();

    fireEvent.click(screen.getByRole('button', { name: 'Обороты не нужны' }));
    expect(declineBacks).toHaveBeenCalledTimes(1);
  });

  it('отказ declineBacks показывается плашкой — своим текстом, без «Проход не начался»', async () => {
    stubApi({
      declineBacks: vi.fn(() => Promise.resolve(fail('storageFailed'))),
    });
    renderFlip();

    fireEvent.click(screen.getByRole('button', { name: 'Обороты не нужны' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Не удалось записать данные на диск');
    expect(alert.textContent).not.toContain('Проход не начался');
  });

  it('S2: идущий проход оборотов меняет кнопки на ожидание и уводит фокус на экран', () => {
    stubApi();
    const pass: PassProgress = {
      phase: 'busy',
      resumed: false,
      kind: 'backs',
      expected: 12,
      params: PARAMS,
      pages: 0,
    };
    renderFlip({ pass });

    const waiting = screen.getByRole('button', { name: 'Ждём, пока сканер освободится…' });
    expect(waiting.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Обороты не нужны' })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('выходной лоток');
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });

  it('потолок ретрая: плашка scannerBusy текстом ошибки, кнопки снова доступны', () => {
    stubApi();
    renderFlip({
      launchFailure: { code: 'scannerBusy' },
    });

    expect(screen.getByRole('alert').textContent).toContain('Сканер занят');
    expect(
      screen
        .getByRole('button', { name: 'Листы в лотке — сканировать обороты' })
        .hasAttribute('disabled'),
    ).toBe(false);
  });

  it('смена устройства между проходами — не тупик: «Подключить заново» ведёт в device', () => {
    stubApi();
    const onOpenDevice = vi.fn();
    const snapshot = makeSnapshot(12);
    renderFlip({
      snapshot: {
        ...snapshot,
        scanner: {
          kind: 'otherDevice',
          scanner: { name: 'ScanPro 200', scheme: 'https', host: '192.0.2.10', port: 443 },
          error: null,
          params: { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' },
        },
      },
      launchFailure: { code: 'scannerCertificateChanged' },
      onOpenDevice,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Подключить заново' }));
    expect(onOpenDevice).toHaveBeenCalledExactlyOnceWith('192.0.2.10:443');
  });

  it('сканер не подключён — кнопка ведёт в device без адреса', () => {
    stubApi();
    const onOpenDevice = vi.fn();
    renderFlip({ launchFailure: { code: 'scannerNotConnected' }, onOpenDevice });

    fireEvent.click(screen.getByRole('button', { name: 'Подключить заново' }));
    expect(onOpenDevice).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('нет бумаги — предупреждение, не ошибка', () => {
    stubApi();
    renderFlip({ launchFailure: { code: 'scanNoPaper' } });

    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('notice--warning');
    expect(alert.textContent).toContain('В лотке нет бумаги');
  });
});
