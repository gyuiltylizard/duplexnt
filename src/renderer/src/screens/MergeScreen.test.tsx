import type {
  AddedSetReport,
  AssembledPage,
  AssemblyReport,
  BlankSummary,
  SessionAssembly,
} from '@shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import '../i18n';
import { NO_BLANK } from '../state/assembly-fixture';
import { MergeScreen } from './MergeScreen';

function report(overrides: Partial<AssemblyReport>): AssemblyReport {
  return {
    mode: 'pairs',
    groups: null,
    sets: [],
    pendingSet: null,
    fronts: 12,
    backs: 12,
    backsState: 'completed',
    backsDeclined: false,
    mismatch: false,
    ...overrides,
  };
}

/** Несовпадение (M3.6): режим наборов с группами по числам проходов. */
const sets = (fronts: number, backs: number, extra: Partial<AssemblyReport> = {}): AssemblyReport =>
  report({
    mode: 'sets',
    groups: { fronts, backs, divider: fronts },
    sets: [],
    pendingSet: null,
    fronts,
    backs,
    mismatch: true,
    ...extra,
  });

/** Порядок под отчёт — как его строит ядро: пары чередованием, наборы — лица, затем обороты. */
function assemblyFor(
  assemblyReport: AssemblyReport,
  blank: BlankSummary = NO_BLANK,
): SessionAssembly {
  const order: AssembledPage[] = [];
  let key = 0;
  const push = (side: AssembledPage['side'], sheet: number | null): void => {
    key += 1;
    order.push({
      key: `k${String(key)}`,
      side,
      sheet,
      angle: 0,
      lost: false,
      addedSet: null,
      blank: null,
    });
  };
  if (assemblyReport.mode === 'sets') {
    for (let index = 0; index < assemblyReport.fronts; index += 1) {
      push('front', index + 1);
    }
    for (let index = 0; index < assemblyReport.backs; index += 1) {
      push('back', index + 1);
    }
  } else {
    for (let sheet = 1; sheet <= assemblyReport.fronts; sheet += 1) {
      push('front', sheet);
      if (sheet <= assemblyReport.backs) {
        push('back', sheet);
      }
    }
  }
  return {
    order,
    documents: [{ name: '', start: 0, count: order.length }],
    sets: assemblyReport.groups,
    orderEdited: false,
    hasEdits: false,
    deleted: 0,
    report: assemblyReport,
    blank,
  };
}

function renderMerge(assemblyReport: AssemblyReport, blank?: BlankSummary) {
  return render(<MergeScreen assembly={assemblyFor(assemblyReport, blank)} />);
}

afterEach(cleanup);

describe('экран merge', () => {
  it('статусная строка — фактический результат, не константа', () => {
    renderMerge(report({ fronts: 7, backs: 7 }));

    expect(screen.getByRole('status').textContent).toBe('совпало пар: 7');
    expect(screen.getByText('Порядок восстановлен: лист N ← лицо N + оборот N')).toBeDefined();
  });

  it('при несовпадении статус сообщает о нём первым, формула про наборы, ряда «документ» нет (R21)', () => {
    const view = renderMerge(sets(12, 11));

    expect(screen.getByRole('status').textContent).toBe(
      'не сошлось: лицевых 12, оборотов 11 — документ соберёте в редакторе',
    );
    expect(
      screen.getByText('Проходы не сошлись — лица и обороты лежат отдельными наборами'),
    ).toBeDefined();
    expect(view.container.querySelector('.merge-screen__row--document')).toBeNull();
    // Ряды проходов на месте.
    expect(view.container.querySelectorAll('.merge-screen__cell--front').length).toBe(12);
    expect(view.container.querySelectorAll('.merge-screen__cell--back').length).toBe(11);
  });

  it('при совпадении ряд «документ» повторяет фактический порядок сборки', () => {
    const view = renderMerge(report({ fronts: 3, backs: 3 }));

    const docCells = view.container.querySelectorAll('.merge-screen__cells--document > *');
    expect(docCells.length).toBe(6);
    expect(docCells[0]?.className).not.toContain('doc-cell--back');
    expect(docCells[1]?.className).toContain('doc-cell--back');
  });

  it('лишние обороты названы и не потеряны', () => {
    renderMerge(sets(12, 13));

    expect(screen.getByRole('status').textContent).toBe(
      'лишних оборотов: 1 — документ соберёте в редакторе',
    );
  });

  it('принятый коротким проход — свой статус', () => {
    renderMerge(sets(12, 7, { backsState: 'accepted' }));

    expect(screen.getByRole('status').textContent).toBe(
      'проход оборотов принят коротким: лицевых 12, оборотов 7',
    );
  });

  it('длинный набор: ряд «документ» упирается в потолок ячеек', () => {
    const view = renderMerge(report({ fronts: 40, backs: 40 }));

    const docCells = view.container.querySelectorAll('.merge-screen__cells--document > *');
    expect(docCells.length).toBe(24);
  });

  it('«Обороты не нужны»: ряд оборотов не рендерится, статус frontsOnly, формулы нет', () => {
    const view = renderMerge(report({ backs: 0, backsState: null, backsDeclined: true }));

    expect(screen.getByRole('status').textContent).toBe('обороты не нужны · страниц: 12');
    expect(screen.queryByText(/обороты \d/)).toBeNull();
    expect(screen.queryByText(/Порядок восстановлен/)).toBeNull();
    expect(view.container.querySelector('.merge-screen__cell--back')).toBeNull();
    expect(view.container.querySelector('.merge-screen__doc-cell--back')).toBeNull();
  });

  it.each([
    [
      '«Скрывать» — найденные',
      { mode: 'hide', found: 3, hidden: 3, pending: 0 },
      'совпало пар: 7 · пустых оборотов: 3',
    ],
    [
      '«Помечать» — найденные',
      { mode: 'mark', found: 2, hidden: 0, pending: 0 },
      'совпало пар: 7 · пустых оборотов: 2',
    ],
    [
      'ничего не найдено',
      { mode: 'hide', found: 0, hidden: 0, pending: 0 },
      'совпало пар: 7 · пустых оборотов: нет',
    ],
    [
      'оценки ещё идут',
      { mode: 'hide', found: 1, hidden: 1, pending: 4 },
      'совпало пар: 7 · ищем пустые обороты…',
    ],
  ] as const)('M4, S12: статус несёт пустые обороты — %s', (_name, blank, expected) => {
    renderMerge(report({ fronts: 7, backs: 7 }), blank);

    expect(screen.getByRole('status').textContent).toBe(expected);
  });

  it('M4: «Оставлять», «Обороты не нужны» и режим наборов — без пустых в статусе', () => {
    renderMerge(report({ fronts: 7, backs: 7 }));
    expect(screen.getByRole('status').textContent).toBe('совпало пар: 7');
    cleanup();

    renderMerge(report({ backs: 0, backsState: null, backsDeclined: true }), {
      mode: 'hide',
      found: 0,
      hidden: 0,
      pending: 0,
    });
    expect(screen.getByRole('status').textContent).toBe('обороты не нужны · страниц: 12');
    cleanup();

    renderMerge(sets(12, 11), { mode: 'hide', found: 2, hidden: 0, pending: 0 });
    expect(screen.getByRole('status').textContent).toBe(
      'не сошлось: лицевых 12, оборотов 11 — документ соберёте в редакторе',
    );
  });

  it('органов управления нет, фокус — на контейнере экрана', () => {
    renderMerge(report({}));

    expect(screen.queryByRole('button')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });
});

// — M4.5 (R9; handoff M4.5, S6): пауза по набору «ДN» —

describe('экран merge для набора (M4.5)', () => {
  const setReport = (overrides: Partial<AddedSetReport>): AddedSetReport => ({
    set: 1,
    fronts: 3,
    backs: 3,
    backsState: 'completed',
    decision: 'none',
    mismatch: false,
    sides: 'two',
    ...overrides,
  });

  /** Пары 12+12 и блок набора «Д1» из `pages` страниц (чередование или подблоки — задаёт тест). */
  function withSet(set: AddedSetReport, blank: BlankSummary = NO_BLANK): SessionAssembly {
    const base = assemblyFor(report({ sets: [set] }), blank);
    const block: AssembledPage[] = [];
    const push = (side: AssembledPage['side'], sheet: number | null, key: string): void => {
      block.push({ key, side, sheet, angle: 0, lost: false, addedSet: 1, blank: null });
    };
    if (set.mismatch) {
      for (let index = 1; index <= set.fronts; index += 1) {
        push('front', null, `sf${String(index)}`);
      }
      for (let index = set.backs; index >= 1; index -= 1) {
        push('back', null, `sb${String(index)}`);
      }
    } else {
      for (let sheet = 1; sheet <= set.fronts; sheet += 1) {
        push('front', sheet, `sf${String(sheet)}`);
        if (sheet <= set.backs) {
          push('back', sheet, `sb${String(sheet)}`);
        }
      }
    }
    return { ...base, order: [...base.order.slice(0, 4), ...block, ...base.order.slice(4)] };
  }

  it('совпало: ряды «лица набора» и «обороты набора», ряд «документ» — чередование блока набора, статус по набору', () => {
    const view = render(<MergeScreen assembly={withSet(setReport({}))} set={1} />);

    expect(screen.getByText('лица набора 1→3')).toBeDefined();
    expect(screen.getByText('обороты набора 3→1')).toBeDefined();
    expect(screen.queryByText('лица 1→12')).toBeNull();
    expect(view.container.querySelectorAll('.merge-screen__cell--front').length).toBe(3);
    const docCells = view.container.querySelectorAll('.merge-screen__cells--document > *');
    expect(docCells.length).toBe(6);
    expect(docCells[1]?.className).toContain('doc-cell--back');
    expect(screen.getByRole('status').textContent).toBe('набор Д1: совпало пар 3');
    expect(screen.getByText('Порядок восстановлен: лист N ← лицо N + оборот N')).toBeDefined();
  });

  it('не сошлось: формула набора, ряда «документ» нет, статус называет числа', () => {
    const view = render(
      <MergeScreen assembly={withSet(setReport({ backs: 2, mismatch: true }))} set={1} />,
    );

    expect(screen.getByRole('status').textContent).toBe('набор Д1: не сошлось — лиц 3, оборотов 2');
    expect(
      screen.getByText(
        'Обороты набора не сошлись — лица и обороты лежат рядом, набор поправите в редакторе',
      ),
    ).toBeDefined();
    expect(view.container.querySelector('.merge-screen__row--document')).toBeNull();
    expect(view.container.querySelectorAll('.merge-screen__cell--back').length).toBe(2);
  });

  it('обороты приняты коротким — свой статус', () => {
    render(
      <MergeScreen
        assembly={withSet(
          setReport({ backs: 2, backsState: 'accepted', decision: 'kept', mismatch: true }),
        )}
        set={1}
      />,
    );

    expect(screen.getByRole('status').textContent).toBe(
      'набор Д1: обороты приняты коротким — лиц 3, оборотов 2',
    );
  });

  it('«Обороты не нужны» для набора: без ряда оборотов и формулы, статус со страницами', () => {
    const view = render(
      <MergeScreen
        assembly={withSet(setReport({ backs: 0, backsState: null, decision: 'declined' }))}
        set={1}
      />,
    );

    expect(screen.getByRole('status').textContent).toBe('набор Д1: обороты не нужны · страниц: 3');
    expect(screen.queryByText(/обороты набора/)).toBeNull();
    expect(screen.queryByText(/Порядок восстановлен/)).toBeNull();
    expect(view.container.querySelector('.merge-screen__cell--back')).toBeNull();
  });

  it('хвост про пустые обороты — по сводке сессии, как у основной пачки', () => {
    render(
      <MergeScreen
        assembly={withSet(setReport({}), { mode: 'hide', found: 1, hidden: 1, pending: 0 })}
        set={1}
      />,
    );

    expect(screen.getByRole('status').textContent).toBe(
      'набор Д1: совпало пар 3 · пустых оборотов: 1',
    );
  });

  it('без набора — экран основной пачки, как раньше', () => {
    render(<MergeScreen assembly={withSet(setReport({}))} set={null} />);

    expect(screen.getByText('лица 1→12')).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe('совпало пар: 12');
  });
});
