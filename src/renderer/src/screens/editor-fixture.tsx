import {
  EMPTY_EDITS,
  ok,
  type Api,
  type PassSnapshot,
  type SessionAssembly,
  type SessionSnapshot,
  type Snapshot,
} from '@shared';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { assemblyOf } from '../state/assembly-fixture';
import { EditorScreen } from './EditorScreen';

// ТОЛЬКО ДЛЯ ТЕСТОВ: общие хелперы тестов экрана `editor` — снимки, заглушка моста, рендер.
// Тесты поделены по смыслу на несколько файлов (правило размера тестового файла).

export function pages(
  count: number,
  from = 1,
  prefix = 'p01-s01',
): { key: string; number: number; lost: boolean }[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `${prefix}-${String(from + index).padStart(4, '0')}`,
    number: from + index,
    lost: false,
  }));
}

export function makePass(overrides: Partial<PassSnapshot>): PassSnapshot {
  return {
    number: 1,
    state: 'completed',
    paramsKnown: true,
    scanner: null,
    rotate180: false,
    pages: pages(3),
    ...overrides,
  };
}

export function makeSnapshot(
  passes: PassSnapshot[],
  overrides: Partial<Snapshot> = {},
  sessionOverrides: Partial<SessionSnapshot> = {},
): Snapshot {
  const session: SessionSnapshot = {
    id: 'session.x',
    backsDeclined: false,
    saved: false,
    edits: EMPTY_EDITS,
    passes,
    ...sessionOverrides,
  };
  return {
    seq: 1,
    scanner: { kind: 'none' },
    pass: null,
    canResume: false,
    canAccept: false,
    storage: { incompatible: false, unsaved: false },
    notices: [],
    ...overrides,
    session,
    assembly: overrides.assembly === undefined ? assemblyOf(session) : overrides.assembly,
  };
}

/**
 * Следующий снимок — как его прислало бы ядро после команды: номер растёт, сессия и сборка
 * меняются целиком (ленту с правками тест задаёт сам — renderer её не считает, KTD-2).
 */
export function nextSnapshot(
  snapshot: Snapshot,
  change: {
    readonly session?: Partial<SessionSnapshot>;
    readonly assembly?: (assembly: SessionAssembly) => SessionAssembly;
  },
): Snapshot {
  if (snapshot.session === null || snapshot.assembly === null) {
    throw new Error('в фикстуре нет сессии');
  }
  return {
    ...snapshot,
    seq: snapshot.seq + 1,
    session: { ...snapshot.session, ...change.session },
    assembly:
      change.assembly === undefined ? snapshot.assembly : change.assembly(snapshot.assembly),
  };
}

/** Двусторонняя фикстура: 3 лица + обороты обратным порядком (AE1). */
export function twoPass(backCount = 3, backsState: PassSnapshot['state'] = 'completed') {
  return makeSnapshot([
    makePass({ pages: pages(3) }),
    makePass({ number: 2, state: backsState, pages: pages(backCount, 1, 'p02-s01') }),
  ]);
}

export function stubApi(overrides: Partial<Record<keyof Api, unknown>> = {}) {
  const api = {
    acceptPass: vi.fn(() => Promise.resolve(ok(undefined))),
    closeSession: vi.fn(() => Promise.resolve(ok(undefined))),
    setEdits: vi.fn(() => Promise.resolve(ok(undefined))),
    savePdf: vi.fn(() =>
      Promise.resolve(ok({ canceled: false, fileName: 'Скан.pdf', directory: 'Документы' })),
    ),
    ...overrides,
  } as unknown as Api;
  vi.stubGlobal('api', api);
  return api;
}

export function renderEditor(
  snapshot: Snapshot,
  overrides: Partial<Parameters<typeof EditorScreen>[0]> = {},
) {
  const onToast = vi.fn();
  const element = (next: Snapshot) => {
    if (next.session === null) {
      throw new Error('в фикстуре нет сессии');
    }
    return (
      <EditorScreen
        snapshot={next}
        session={next.session}
        resumeFailure={null}
        onResume={vi.fn()}
        onOpenDevice={vi.fn()}
        onToast={onToast}
        {...overrides}
      />
    );
  };
  const view = render(element(snapshot));
  /** Новый снимок в тот же экран — как его доставило бы хранилище снимка. */
  const rerender = (next: Snapshot): void => {
    view.rerender(element(next));
  };
  return { view, onToast, rerender };
}
