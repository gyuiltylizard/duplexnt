import type { PassProgress, SessionSnapshot, Snapshot } from '@shared';
import { describe, expect, it } from 'vitest';
import { screenOf } from './screen';

const SESSION: SessionSnapshot = {
  id: 'session.20261003-120000-abcd',
  backsDeclined: false,
  saved: false,
  passes: [
    {
      number: 1,
      state: 'completed',
      paramsKnown: true,
      scanner: null,
      rotate180: false,
      pages: [{ key: 'p01-s01-0001', number: 1, lost: false }],
    },
  ],
};

const PASS: PassProgress = {
  phase: 'scanning',
  resumed: false,
  params: { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' },
  pages: 1,
};

function makeSnapshot(overrides: Partial<Snapshot>): Snapshot {
  return {
    seq: 1,
    scanner: { kind: 'none' },
    session: null,
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

  it('сессия со страницами без прохода — editor', () => {
    expect(screenOf(makeSnapshot({ session: SESSION }))).toBe('editor');
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
});
