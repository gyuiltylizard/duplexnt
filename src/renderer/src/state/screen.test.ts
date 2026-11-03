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
    kind: 'fronts',
    after: null,
    pair: null,
    backsDecision: null,
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
    assembled: null,
    blankMode: 'keep',
    straighten: 'off',
    passes: [makePass({})],
    ...overrides,
  };
}

const SESSION = makeSession({});

const PASS: PassProgress = {
  phase: 'scanning',
  resumed: false,
  kind: 'fronts',
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
    blankMode: 'hide',
    straightenMode: 'auto',
    language: 'ru',
    straightenProgress: null,
    seenHints: [],
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
          kind: 'backs',
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
          kind: 'backs',
          state: 'interrupted',
          pages: [{ key: 'p02-s01-0001', number: 1, lost: false }],
        }),
      ],
    });
    expect(screenOf(makeSnapshot({ session }))).toBe('editor');
  });

  it('пустой проход роли не занимает при любом kind (KTD-4): прерванные до первой страницы обороты — flip', () => {
    const session = makeSession({
      passes: [
        makePass({}),
        makePass({ number: 2, kind: 'backs', state: 'interrupted', pages: [] }),
      ],
    });
    expect(screenOf(makeSnapshot({ session }))).toBe('flip');
  });

  // — M3.5 (KTD-4): роль — `kind`, не позиция; добавленный набор — всегда `editor` —

  it('роль по kind, не по позиции: лицевые — проход №3 после двух остановок — flip', () => {
    const session = makeSession({ passes: [makePass({ number: 3 })] });
    expect(screenOf(makeSnapshot({ session }))).toBe('flip');
  });

  it.each([true, false])(
    '[лицевые, добавленный] при backsDeclined=%s — editor: разворот позади',
    (backsDeclined) => {
      const session = makeSession({
        backsDeclined,
        passes: [
          makePass({}),
          makePass({
            number: 2,
            kind: 'added',
            after: 'p01-s01-0001',
            pages: [{ key: 'p02-s01-0001', number: 1, lost: false }],
          }),
        ],
      });
      expect(screenOf(makeSnapshot({ session }))).toBe('editor');
    },
  );

  it.each(['starting', 'busy'] as const)(
    'добавленный проход в фазе %s без страниц — сразу scan: ожидание S2 только у оборотов',
    (phase) => {
      const pass: PassProgress = { ...PASS, kind: 'added', phase, pages: 0 };
      expect(screenOf(makeSnapshot({ pass, session: SESSION }))).toBe('scan');
    },
  );

  // — S2 (KTD-11): запуск оборотов с flip при занятом устройстве не уводит с экрана —

  it.each(['starting', 'busy'] as const)(
    'проход оборотов в фазе %s без страниц — остаёмся на flip',
    (phase) => {
      const pass: PassProgress = { ...PASS, kind: 'backs', phase, expected: 12, pages: 0 };
      expect(screenOf(makeSnapshot({ pass, session: SESSION }))).toBe('flip');
    },
  );

  it('первая страница оборотов уводит на scan', () => {
    const pass: PassProgress = { ...PASS, kind: 'backs', phase: 'busy', expected: 12, pages: 1 };
    expect(screenOf(makeSnapshot({ pass, session: SESSION }))).toBe('scan');
  });

  it('фаза scanning оборотов — scan и без страниц', () => {
    const pass: PassProgress = {
      ...PASS,
      kind: 'backs',
      phase: 'scanning',
      expected: 12,
      pages: 0,
    };
    expect(screenOf(makeSnapshot({ pass, session: SESSION }))).toBe('scan');
  });

  it('досканирование прерванных оборотов — сразу scan (семантика M1)', () => {
    const pass: PassProgress = {
      ...PASS,
      kind: 'backs',
      phase: 'busy',
      expected: 12,
      pages: 0,
      resumed: true,
    };
    expect(screenOf(makeSnapshot({ pass, session: SESSION }))).toBe('scan');
  });

  it('лицевой проход в фазе busy — scan: ожидание занятости S2 только у оборотов', () => {
    const pass: PassProgress = { ...PASS, phase: 'busy', pages: 0 };
    expect(screenOf(makeSnapshot({ pass }))).toBe('scan');
  });
});

// — M4.5 (KTD7): набор, ждущий обороты, — `flip` с приоритетом над `editor` —

describe('screenOf: двусторонний набор (M4.5)', () => {
  const setPage = (number: number, index: number) => ({
    key: `p0${String(number)}-s01-${String(index).padStart(4, '0')}`,
    number: index,
    lost: false,
  });
  const mainBacks = makePass({ number: 2, kind: 'backs', pages: [setPage(2, 1)] });
  const main = [makePass({}), mainBacks];
  const setFronts = (extra: Partial<PassSnapshot> = {}) =>
    makePass({
      number: 3,
      kind: 'addedFronts',
      after: 'p01-s01-0001',
      backsDecision: 'none',
      pages: [setPage(3, 1), setPage(3, 2)],
      ...extra,
    });
  const setBacks = (extra: Partial<PassSnapshot> = {}) =>
    makePass({ number: 4, kind: 'addedBacks', pair: 3, pages: [setPage(4, 1)], ...extra });

  it.each([
    ['лица набора завершены', setFronts({})],
    ['лица набора приняты', setFronts({ state: 'accepted' })],
  ])('%s → flip набора, даже при отказе по основной пачке', (_name, fronts) => {
    for (const backsDeclined of [false, true]) {
      const session = makeSession({
        backsDeclined,
        passes: [makePass({}), ...(backsDeclined ? [] : [mainBacks]), fronts],
      });
      expect(screenOf(makeSnapshot({ session }))).toBe('flip');
    }
  });

  it('другие наборы не мешают: односторонний и закрытая пара рядом с ожидающим набором — flip', () => {
    const session = makeSession({
      passes: [
        ...main,
        makePass({ number: 3, kind: 'added', after: null, pages: [setPage(3, 1)] }),
        makePass({
          number: 4,
          kind: 'addedFronts',
          after: null,
          backsDecision: 'kept',
          pages: [setPage(4, 1)],
        }),
        makePass({ number: 5, kind: 'addedBacks', pair: 4, pages: [setPage(5, 1), setPage(5, 2)] }),
        setFronts({ number: 6 }),
      ],
    });
    expect(screenOf(makeSnapshot({ session }))).toBe('flip');
  });

  it.each([
    ['отказ от оборотов набора', [setFronts({ backsDecision: 'declined' })]],
    ['обороты набора есть', [setFronts({}), setBacks({})]],
    ['обороты набора прерваны со страницами', [setFronts({}), setBacks({ state: 'interrupted' })]],
    ['лица набора прерваны — плашка', [setFronts({ state: 'interrupted' })]],
  ])('%s → editor', (_name, setPasses) => {
    const session = makeSession({ passes: [...main, ...setPasses] });
    expect(screenOf(makeSnapshot({ session }))).toBe('editor');
  });

  it('обороты набора, прерванные до первой страницы, роли не занимают — flip набора', () => {
    const session = makeSession({
      passes: [...main, setFronts({}), setBacks({ state: 'interrupted', pages: [] })],
    });
    expect(screenOf(makeSnapshot({ session }))).toBe('flip');
  });

  it.each(['starting', 'busy'] as const)(
    'S2 для набора: обороты набора в фазе %s без страниц — остаёмся на flip',
    (phase) => {
      const session = makeSession({ passes: [...main, setFronts({})] });
      const pass: PassProgress = { ...PASS, kind: 'addedBacks', phase, expected: 2, pages: 0 };
      expect(screenOf(makeSnapshot({ pass, session }))).toBe('flip');
    },
  );

  it('лица набора в фазе busy — сразу scan: ожидание S2 только у оборотов', () => {
    const session = makeSession({ passes: main });
    const pass: PassProgress = { ...PASS, kind: 'addedFronts', phase: 'busy', pages: 0 };
    expect(screenOf(makeSnapshot({ pass, session }))).toBe('scan');
  });
});
