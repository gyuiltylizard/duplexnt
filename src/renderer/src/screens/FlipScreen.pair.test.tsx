import {
  EMPTY_EDITS,
  fail,
  ok,
  type Api,
  type PassProgress,
  type PassSnapshot,
  type Snapshot,
} from '@shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { assemblyOf } from '../state/assembly-fixture';
import { FlipScreen } from './FlipScreen';

// `flip` для двустороннего набора (план M4.5, U6; R6; handoff M4.5, S5): кикер в акценте набора
// с числом его листов, тексты и кнопки основной пачки, «Обороты не нужны» — тот же `declineBacks`
// (адресует ядро), занятость — при идущих оборотах набора.

const PARAMS = { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' } as const;

function makePass(overrides: Partial<PassSnapshot>): PassSnapshot {
  return {
    number: 1,
    state: 'completed',
    paramsKnown: true,
    scanner: null,
    kind: 'fronts',
    after: null,
    pair: null,
    backsDecision: null,
    rotate180: false,
    pages: [],
    ...overrides,
  };
}

const pages = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => ({
    key: `${prefix}-${String(index + 1).padStart(4, '0')}`,
    number: index + 1,
    lost: false,
  }));

/** Пары 12+12 плюс лица набора «Д1» из `setFronts` листов, обороты ещё не сканированы. */
function makeSnapshot(setFronts: number): Snapshot {
  const session = {
    blankMode: 'keep' as const,
    straighten: 'off' as const,
    id: 'session.x',
    backsDeclined: false,
    saved: false,
    edits: EMPTY_EDITS,
    assembled: null,
    passes: [
      makePass({ pages: pages(12, 'p01-s01') }),
      makePass({ number: 2, kind: 'backs', pages: pages(12, 'p02-s01') }),
      makePass({
        number: 3,
        kind: 'addedFronts',
        after: 'p01-s01-0004',
        backsDecision: 'none',
        pages: pages(setFronts, 'p03-s01'),
      }),
    ],
  };
  return {
    seq: 1,
    scanner: { kind: 'none' },
    session,
    assembly: assemblyOf(session),
    pass: null,
    canResume: false,
    canAccept: false,
    storage: { incompatible: false, unsaved: false },
    notices: [],
    blankMode: 'hide',
    straightenMode: 'auto',
    language: 'ru',
    straightenProgress: null,
    seenHints: [],
  };
}

function stubApi(overrides: Partial<Record<keyof Api, unknown>> = {}) {
  const api = {
    declineBacks: vi.fn(() => Promise.resolve(ok(undefined))),
    ...overrides,
  } as unknown as Api;
  vi.stubGlobal('api', api);
  return { declineBacks: api.declineBacks };
}

function renderFlip(overrides: Partial<Parameters<typeof FlipScreen>[0]> = {}) {
  const props = {
    snapshot: makeSnapshot(3),
    pass: null,
    launchFailure: null,
    onStart: vi.fn(),
    onOpenDevice: vi.fn(),
    ...overrides,
  };
  render(<FlipScreen {...props} />);
  return props;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('FlipScreen для набора (M4.5)', () => {
  it('кикер набора в акценте набора несёт число листов набора, а не основной пачки', () => {
    stubApi();
    renderFlip();

    const kicker = screen.getByText('ДОБАВЛЯЕМ · ЛИЦА ГОТОВЫ: 3 листа');
    expect(kicker.className).toBe('kicker kicker--added');
    expect(screen.queryByText(/ШАГ 2 ИЗ 3/)).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Разверните листы на 180° — все разом',
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });

  it.each([
    [1, 'ДОБАВЛЯЕМ · ЛИЦА ГОТОВЫ: 1 лист'],
    [5, 'ДОБАВЛЯЕМ · ЛИЦА ГОТОВЫ: 5 листов'],
    [22, 'ДОБАВЛЯЕМ · ЛИЦА ГОТОВЫ: 22 листа'],
  ])('плюрализация кикера набора: %i', (count, expected) => {
    stubApi();
    renderFlip({ snapshot: makeSnapshot(count) });

    expect(screen.getByText(expected)).toBeDefined();
  });

  it('«Листы в лотке — сканировать обороты» зовёт onStart: роль решает ядро', () => {
    stubApi();
    const { onStart } = renderFlip();

    fireEvent.click(screen.getByRole('button', { name: 'Листы в лотке — сканировать обороты' }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('«Обороты не нужны» — один declineBacks: повторный клик до ответа не шлёт второй', async () => {
    let answer: (result: unknown) => void = () => undefined;
    const { declineBacks } = stubApi({
      declineBacks: vi.fn(() => new Promise((resolve) => (answer = resolve))),
    });
    renderFlip();

    const skip = screen.getByRole('button', { name: 'Обороты не нужны' });
    fireEvent.click(skip);
    fireEvent.click(skip);
    expect(declineBacks).toHaveBeenCalledTimes(1);
    expect(skip.hasAttribute('disabled')).toBe(true);
    await act(async () => {
      answer(ok(undefined));
      await Promise.resolve();
    });
    expect(skip.hasAttribute('disabled')).toBe(false);
  });

  it('отказ declineBacks по набору — плашкой с причиной ядра', async () => {
    stubApi({
      declineBacks: vi.fn(() =>
        Promise.resolve(fail('sessionConflict', { reason: 'pairPending' })),
      ),
    });
    renderFlip();

    fireEvent.click(screen.getByRole('button', { name: 'Обороты не нужны' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Набор ждёт обороты');
  });

  it('S2: идущие обороты набора без страниц — ожидание, кнопок нет', () => {
    stubApi();
    const pass: PassProgress = {
      phase: 'busy',
      resumed: false,
      kind: 'addedBacks',
      expected: 3,
      params: PARAMS,
      pages: 0,
    };
    renderFlip({ pass });

    expect(
      screen
        .getByRole('button', { name: 'Ждём, пока сканер освободится…' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Обороты не нужны' })).toBeNull();
    expect(screen.getByText('ДОБАВЛЯЕМ · ЛИЦА ГОТОВЫ: 3 листа')).toBeDefined();
  });
});
