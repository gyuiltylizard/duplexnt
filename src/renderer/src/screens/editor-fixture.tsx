import {
  EMPTY_EDITS,
  NO_VERDICTS,
  ok,
  type Api,
  type BlankVerdicts,
  type CommandResult,
  type PassSnapshot,
  type SaveDocumentsRequest,
  type SessionAssembly,
  type SessionEdits,
  type SessionSnapshot,
  type Snapshot,
} from '@shared';
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { assemblyOf, assemblyWithEditsOf } from '../state/assembly-fixture';
import type { DropSide } from '../state/edits';
import type { EditState } from '../state/history';
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
    kind: 'fronts',
    after: null,
    pair: null,
    backsDecision: null,
    rotate180: false,
    pages: pages(3),
    ...overrides,
  };
}

/** `blank` — вердикты детектора по ключам оборотов (M4): флаги ленты считает зеркало сборки. */
export function makeSnapshot(
  passes: PassSnapshot[],
  overrides: Partial<Snapshot> = {},
  sessionOverrides: Partial<SessionSnapshot> = {},
  blank: BlankVerdicts = NO_VERDICTS,
): Snapshot {
  const session: SessionSnapshot = {
    id: 'session.x',
    backsDeclined: false,
    saved: false,
    edits: EMPTY_EDITS,
    assembled: null,
    blankMode: 'keep',
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
    blankMode: 'hide',
    ...overrides,
    session,
    assembly: overrides.assembly === undefined ? assemblyOf(session, blank) : overrides.assembly,
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
    makePass({
      number: 2,
      kind: 'backs',
      state: backsState,
      pages: pages(backCount, 1, 'p02-s01'),
    }),
  ]);
}

// Лента двусторонней фикстуры (AE1): 1л, 1о, 2л, 2о, 3л, 3о.
export const F1 = 'p01-s01-0001';
export const B3 = 'p02-s01-0003';
export const F2 = 'p01-s01-0002';
export const B2 = 'p02-s01-0002';
export const F3 = 'p01-s01-0003';
export const B1 = 'p02-s01-0001';

/** Номер последнего показанного снимка: ответ `setEdits` по умолчанию — следующий за ним. */
let shownSeq = 0;

export function stubApi(overrides: Partial<Record<keyof Api, unknown>> = {}) {
  const api = {
    acceptPass: vi.fn(() => Promise.resolve(ok(undefined))),
    closeSession: vi.fn(() => Promise.resolve(ok(undefined))),
    assemble: vi.fn(() => Promise.resolve(ok(undefined))),
    // Как ядро: результат команды несёт снимок, следующий за показанным (M3, ревью сессий 3–4).
    setEdits: vi.fn(() => Promise.resolve(ok({ seq: shownSeq + 1 }))),
    getSaveFolder: vi.fn(() => Promise.resolve(ok('C:\\Документы'))),
    chooseSaveFolder: vi.fn(() => Promise.resolve(ok({ canceled: true, folder: 'C:\\Документы' }))),
    // Пакет записан целиком под запрошенными именами.
    saveDocuments: vi.fn((request: SaveDocumentsRequest) =>
      Promise.resolve(
        ok({
          folder: 'C:\\Документы',
          written: request.names.map((name, index) => ({ index, fileName: `${name}.pdf` })),
          failed: [],
        }),
      ),
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
    shownSeq = next.seq;
    return (
      <EditorScreen
        snapshot={next}
        session={next.session}
        initialCurrent={null}
        resumeFailure={null}
        onResume={vi.fn()}
        onAdd={vi.fn()}
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

/** Правки поверх пустых — короткая запись в ожиданиях тестов. */
export const edits = (change: Partial<SessionEdits>): SessionEdits => ({
  ...EMPTY_EDITS,
  ...change,
});

/**
 * Снимок после того, как ядро приняло правки `state`: сессия несёт их дословно (нормализации нет
 * — тест подаёт ровно то, что ушло в `setEdits`), сборка — зеркало ядра с правками
 * (`assemblyWithEditsOf`, сверено с ядром guard-тестом).
 */
export function applied(
  snapshot: Snapshot,
  /** Состояние правок или запрос моста (`lastSent`): карта флагов по проходам (M4.5, KTD4). */
  state: EditState | Parameters<Api['setEdits']>[0],
  blank: BlankVerdicts = NO_VERDICTS,
): Snapshot {
  const session = snapshot.session;
  if (session === null) {
    throw new Error('в фикстуре нет сессии');
  }
  const flagOf = (number: number): boolean =>
    typeof state.rotate180 === 'boolean' ? state.rotate180 : (state.rotate180[number] ?? false);
  const next: SessionSnapshot = {
    ...session,
    edits: state.edits,
    passes: session.passes.map((pass) =>
      pass.kind === 'backs' || pass.kind === 'addedBacks'
        ? { ...pass, rotate180: flagOf(pass.number) }
        : pass,
    ),
  };
  return {
    ...snapshot,
    seq: snapshot.seq + 1,
    session: next,
    assembly: assemblyWithEditsOf(next, blank),
  };
}

/** `setEdits`, чей ответ тест отдаёт сам — до или после снимка с результатом. */
export function deferredSetEdits() {
  let answer: (result: CommandResult<'setEdits'>) => void = () => undefined;
  const setEdits = vi.fn(
    () =>
      new Promise<CommandResult<'setEdits'>>((resolve) => {
        answer = resolve;
      }),
  );
  return {
    setEdits,
    answer: (result: CommandResult<'setEdits'>): void => {
      answer(result);
    },
  };
}

/** Последнее, что ушло в `setEdits` — запрос моста: флаги 180° картой по проходам (M4.5, KTD4). */
export function lastSent(api: Api): Parameters<Api['setEdits']>[0] {
  const calls = vi.mocked(api.setEdits).mock.calls;
  const state = calls[calls.length - 1]?.[0];
  if (state === undefined) {
    throw new Error('setEdits не вызывался');
  }
  return state;
}

export const option = (index: number): HTMLElement => {
  const element = screen.getAllByRole('option')[index];
  if (element === undefined) {
    throw new Error(`нет миниатюры ${String(index)}`);
  }
  return element;
};

export const selectedKeys = (): (string | null)[] =>
  screen
    .getAllByRole('option')
    .filter((element) => element.getAttribute('aria-selected') === 'true')
    .map((element) => element.getAttribute('data-key'));

/** Поле имени документа `number` (с единицы). */
export const nameField = (number: number): HTMLInputElement =>
  screen.getByRole<HTMLInputElement>('textbox', { name: `Название документа ${String(number)}` });

export const ctrlZ = (target: Element = document.body): void => {
  fireEvent.keyDown(target, { key: 'z', code: 'KeyZ', ctrlKey: true });
};

/** Ответ моста приходит микротаском — дождаться его до следующего снимка. */
export const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

/**
 * Самодельный `dataTransfer`: в jsdom его нет (KTD-8). Лента пишет в него только тип данных
 * и эффект — этого достаточно.
 */
export function dataTransfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    dropEffect: 'none',
    effectAllowed: 'all',
    setData: (type: string, value: string) => {
      data.set(type, value);
    },
    getData: (type: string) => data.get(type) ?? '',
  } as unknown as DataTransfer;
}

/**
 * `dragover` над миниатюрой в её левой (`before`) или правой (`after`) половине. jsdom не
 * знает `DragEvent` и не раскладывает страницу: координату события и рамку задаёт тест.
 */
export function dragOver(target: HTMLElement, side: DropSide, transfer: DataTransfer) {
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    right: 180,
    top: 0,
    bottom: 120,
    width: 80,
    height: 120,
    x: 100,
    y: 0,
    toJSON: () => ({}),
  });
  const event = createEvent.dragOver(target, { dataTransfer: transfer });
  Object.defineProperty(event, 'clientX', { value: side === 'before' ? 110 : 170 });
  fireEvent(target, event);
}

/** Перетаскивание целиком: взять, провести над целью, бросить, отпустить. */
export function dragAndDrop(source: HTMLElement, target: HTMLElement, side: DropSide) {
  const transfer = dataTransfer();
  fireEvent.dragStart(source, { dataTransfer: transfer });
  dragOver(target, side, transfer);
  fireEvent.drop(target, { dataTransfer: transfer });
  fireEvent.dragEnd(source, { dataTransfer: transfer });
}
