import { EMPTY_EDITS, type PassProgress, type PassSnapshot, type Snapshot } from '@shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { ScanScreen } from './ScanScreen';

// `scan` проходов двустороннего набора (план M4.5, U6; R5, R7; handoff M4.5, S3–S4): тег с
// ролью на цвете набора, счётчик «из N» у оборотов набора, мета досканирования с номером набора.

const PARAMS = { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' } as const;

const pages = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => ({
    key: `${prefix}-${String(index + 1).padStart(4, '0')}`,
    number: index + 1,
    lost: false,
  }));

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

/** Пары 3+3 и проходы набора «Д1» — лица и, если есть, идущий или прерванный проход. */
function makeSnapshot(setPasses: readonly PassSnapshot[], pass: PassProgress): Snapshot {
  return {
    seq: 1,
    scanner: { kind: 'none' },
    session: {
      blankMode: 'keep',
      id: 'session.x',
      backsDeclined: false,
      saved: false,
      edits: EMPTY_EDITS,
      assembled: null,
      passes: [
        makePass({ pages: pages(3, 'p01-s01') }),
        makePass({ number: 2, kind: 'backs', pages: pages(3, 'p02-s01') }),
        ...setPasses,
      ],
    },
    assembly: null,
    pass,
    canResume: false,
    canAccept: false,
    storage: { incompatible: false, unsaved: false },
    notices: [],
    blankMode: 'hide',
    seenHints: [],
  };
}

const FRONTS = makePass({
  number: 3,
  kind: 'addedFronts',
  after: 'p01-s01-0002',
  backsDecision: 'none',
  pages: pages(3, 'p03-s01'),
});

const progress = (overrides: Partial<PassProgress>): PassProgress => ({
  phase: 'scanning',
  resumed: false,
  kind: 'addedBacks',
  expected: 3,
  params: PARAMS,
  pages: 2,
  ...overrides,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ScanScreen проходов набора (M4.5)', () => {
  it('S4: обороты набора — тег «ДОБАВЛЯЕМ · ОБОРОТЫ» на цвете набора, счётчик «из N»', () => {
    const backs = makePass({
      number: 4,
      kind: 'addedBacks',
      pair: 3,
      state: 'running',
      pages: pages(2, 'p04-s01'),
    });
    const pass = progress({});
    render(
      <ScanScreen snapshot={makeSnapshot([FRONTS, backs], pass)} pass={pass} onStop={vi.fn()} />,
    );

    const tag = screen.getByText('ДОБАВЛЯЕМ · ОБОРОТЫ');
    expect(tag.className).toBe('scan-screen__tag scan-screen__tag--added');
    expect(screen.getByRole('status').textContent).toBe('Отсканировано 2 из 3');
    expect(screen.getByText('300 dpi · оттенки серого · A4')).toBeDefined();
  });

  it('S3: лица набора — тег «ДОБАВЛЯЕМ · ЛИЦА», счётчик без «из N»', () => {
    const fronts = makePass({ ...FRONTS, state: 'running', pages: pages(2, 'p03-s01') });
    const pass = progress({ kind: 'addedFronts', expected: null });
    render(<ScanScreen snapshot={makeSnapshot([fronts], pass)} pass={pass} onStop={vi.fn()} />);

    expect(screen.getByText('ДОБАВЛЯЕМ · ЛИЦА').className).toBe(
      'scan-screen__tag scan-screen__tag--added',
    );
    expect(screen.getByRole('status').textContent).toBe('Отсканировано 2');
  });

  it('досканирование оборотов набора: мета называет набор «Д1» и страницы до обрыва', () => {
    const backs = makePass({
      number: 4,
      kind: 'addedBacks',
      pair: 3,
      state: 'interrupted',
      pages: pages(2, 'p04-s01'),
    });
    const pass = progress({ resumed: true, phase: 'starting', pages: 0 });
    render(
      <ScanScreen snapshot={makeSnapshot([FRONTS, backs], pass)} pass={pass} onStop={vi.fn()} />,
    );

    expect(screen.getByText(/^досканируем набор Д1 · до обрыва было 2 · /)).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe('Начинаем проход…');
  });

  it('досканирование одностороннего набора — прежняя мета M3.5 без номера (ревью 3–4)', () => {
    const added = makePass({
      number: 3,
      kind: 'added',
      after: 'p01-s01-0002',
      state: 'interrupted',
      pages: pages(2, 'p03-s01'),
    });
    const pass = progress({ kind: 'added', expected: null, resumed: true, pages: 0 });
    render(<ScanScreen snapshot={makeSnapshot([added], pass)} pass={pass} onStop={vi.fn()} />);

    expect(screen.getByText(/^досканируем добавленный набор · до обрыва было 2 · /)).toBeDefined();
    expect(screen.queryByText(/набор Д1/)).toBeNull();
  });

  it('досканирование основной пачки и одностороннего набора — прежние меты', () => {
    const interruptedBacks = makePass({
      number: 2,
      kind: 'backs',
      state: 'interrupted',
      pages: pages(1, 'p02-s01'),
    });
    const pass = progress({ kind: 'backs', resumed: true, pages: 0 });
    const snapshot = makeSnapshot([], pass);
    const session = snapshot.session;
    render(
      <ScanScreen
        snapshot={{
          ...snapshot,
          session: session && {
            ...session,
            passes: [makePass({ pages: pages(3, 'p01-s01') }), interruptedBacks],
          },
        }}
        pass={pass}
        onStop={vi.fn()}
      />,
    );
    expect(screen.getByText(/^досканируем обороты · до обрыва было 1 · /)).toBeDefined();
    expect(screen.getByText('СКАНИРУЕМ ОБОРОТЫ').className).toBe('scan-screen__tag');
  });
});
