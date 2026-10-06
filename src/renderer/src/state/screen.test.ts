import {
  EMPTY_EDITS,
  type PassProgress,
  type PassSnapshot,
  type SessionSnapshot,
  type Snapshot,
} from '@shared';
import { describe, expect, it } from 'vitest';
import { screenOf } from './screen';

function makePass(overrides: Partial<PassSnapshot>): PassSnapshot {
  return {
    number: 1,
    state: 'completed',
    paramsKnown: true,
    scanner: null,
    rotate180: false,
    pages: [{ key: 'p01-s01-0001', number: 1, lost: false }],
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionSnapshot>): SessionSnapshot {
  return {
    id: 'session.20261003-120000-abcd',
    backsDeclined: false,
    saved: false,
    edits: EMPTY_EDITS,
    passes: [makePass({})],
    ...overrides,
  };
}

const SESSION = makeSession({});

const PASS: PassProgress = {
  phase: 'scanning',
  resumed: false,
  expected: null,
  params: { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' },
  pages: 1,
};

function makeSnapshot(overrides: Partial<Snapshot>): Snapshot {
  return {
    seq: 1,
    scanner: { kind: 'none' },
    session: null,
    assembly: null,
    pass: null,
    canResume: false,
    canAccept: false,
    storage: { incompatible: false, unsaved: false },
    notices: [],
    ...overrides,
  };
}

describe('screenOf', () => {
  it('нет сессии — setup', () => {
    expect(screenOf(makeSnapshot({}))).toBe('setup');
  });

  it('идущий проход — scan', () => {
    expect(screenOf(makeSnapshot({ pass: PASS, session: SESSION }))).toBe('scan');
  });

  it('несовместимые данные перекрывают всё — incompatible', () => {
    expect(
      screenOf(
        makeSnapshot({
          storage: { incompatible: true, unsaved: false },
          session: SESSION,
          pass: PASS,
        }),
      ),
    ).toBe('incompatible');
  });

  // — форма «flip» (M2, KTD-5): единственный уцелевший проход — лицевой, завершён или принят —

  it('завершённый лицевой без оборотов и отказа — flip', () => {
    expect(screenOf(makeSnapshot({ session: SESSION }))).toBe('flip');
  });

  it('принятый как есть лицевой — тоже flip', () => {
    const session = makeSession({ passes: [makePass({ state: 'accepted' })] });
    expect(screenOf(makeSnapshot({ session }))).toBe('flip');
  });

  it('после declineBacks — editor, не flip', () => {
    const session = makeSession({ backsDeclined: true });
    expect(screenOf(makeSnapshot({ session }))).toBe('editor');
  });

  it('прерванный лицевой — editor (досканирование, как M1)', () => {
    const session = makeSession({ passes: [makePass({ state: 'interrupted' })] });
    expect(screenOf(makeSnapshot({ session }))).toBe('editor');
  });

  it('два уцелевших прохода — editor: обороты уже есть', () => {
    const session = makeSession({
      passes: [
        makePass({}),
        makePass({
          number: 2,
          pages: [{ key: 'p02-s01-0001', number: 1, lost: false }],
        }),
      ],
    });
    expect(screenOf(makeSnapshot({ session }))).toBe('editor');
  });

  it('прерванный проход оборотов — editor (canResume/canAccept, не flip)', () => {
    const session = makeSession({
      passes: [
        makePass({}),
        makePass({
          number: 2,
          state: 'interrupted',
          pages: [{ key: 'p02-s01-0001', number: 1, lost: false }],
        }),
      ],
    });
    expect(screenOf(makeSnapshot({ session }))).toBe('editor');
  });

  it('пустой проход не считается уцелевшим: роль по позиции, не по номеру (KTD-4)', () => {
    const session = makeSession({
      passes: [makePass({}), makePass({ number: 2, state: 'running', pages: [] })],
    });
    // Снимок без идущего прохода, но с пустой записью — страхующий фильтр оставляет flip.
    expect(screenOf(makeSnapshot({ session }))).toBe('flip');
  });

  // — S2 (KTD-11): запуск оборотов с flip при занятом устройстве не уводит с экрана —

  it.each(['starting', 'busy'] as const)(
    'проход оборотов в фазе %s без страниц — остаёмся на flip',
    (phase) => {
      const pass: PassProgress = { ...PASS, phase, expected: 12, pages: 0 };
      expect(screenOf(makeSnapshot({ pass, session: SESSION }))).toBe('flip');
    },
  );

  it('первая страница оборотов уводит на scan', () => {
    const pass: PassProgress = { ...PASS, phase: 'busy', expected: 12, pages: 1 };
    expect(screenOf(makeSnapshot({ pass, session: SESSION }))).toBe('scan');
  });

  it('фаза scanning оборотов — scan и без страниц', () => {
    const pass: PassProgress = { ...PASS, phase: 'scanning', expected: 12, pages: 0 };
    expect(screenOf(makeSnapshot({ pass, session: SESSION }))).toBe('scan');
  });

  it('досканирование прерванных оборотов — сразу scan (семантика M1)', () => {
    const pass: PassProgress = { ...PASS, phase: 'busy', expected: 12, pages: 0, resumed: true };
    expect(screenOf(makeSnapshot({ pass, session: SESSION }))).toBe('scan');
  });

  it('лицевой проход в фазе busy — scan: ожидание занятости S2 только у оборотов', () => {
    const pass: PassProgress = { ...PASS, phase: 'busy', pages: 0 };
    expect(screenOf(makeSnapshot({ pass }))).toBe('scan');
  });
});
