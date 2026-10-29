import {
  NO_STRAIGHTEN,
  NO_STRAIGHTEN_MARK,
  type AddedSetReport,
  type AssembledPage,
  type AssemblyReport,
  type BlankSummary,
  type SessionAssembly,
  type StraightenSummary,
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
      straighten: NO_STRAIGHTEN_MARK,
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
    straighten: NO_STRAIGHTEN,
  };
}

const title = (): string | null => screen.getByRole('heading', { level: 1 }).textContent;

function renderMerge(assemblyReport: AssemblyReport, blank?: BlankSummary) {
  return render(<MergeScreen assembly={assemblyFor(assemblyReport, blank)} />);
}

/** Сводка выравнивания (M6) поверх нулевой: режим `auto`, остальное — по переданному. */
const straightenOf = (
  overrides: Partial<StraightenSummary>,
  mode: StraightenSummary['mode'] = 'auto',
): StraightenSummary => ({ ...NO_STRAIGHTEN, mode, ...overrides });

function renderMergeStraight(
  assemblyReport: AssemblyReport,
  straighten: StraightenSummary,
  blank: BlankSummary = NO_BLANK,
) {
  return render(<MergeScreen assembly={{ ...assemblyFor(assemblyReport, blank), straighten }} />);
}

afterEach(cleanup);

describe('экран merge', () => {
  it('статусная строка — фактический результат, не константа', () => {
    renderMerge(report({ fronts: 7, backs: 7 }));

    expect(screen.getByRole('status').textContent).toBe('совпало пар: 7');
    expect(title()).toBe('Сопоставляем лица и обороты');
  });

  it('B-5: сошлось — иллюстрация «пары», строка не янтарная, тега набора нет', () => {
    const view = renderMerge(report({ fronts: 3, backs: 3 }));

    expect(view.container.querySelector('.sort')?.className).toBe('sort');
    expect(view.container.querySelector('.sort')?.getAttribute('aria-hidden')).toBe('true');
    // Шесть листов — всегда: число несёт строка, не картинка.
    expect(view.container.querySelectorAll('.sort__sheet')).toHaveLength(6);
    expect(screen.getByRole('status').className).not.toContain('--warning');
    expect(view.container.querySelector('.merge-screen__tag')).toBeNull();
  });

  it('при несовпадении — янтарная строка с точкой; иллюстрация та же, что при совпадении (R21, B-5)', () => {
    const view = renderMerge(sets(12, 11));

    const status = screen.getByRole('status');
    expect(status.textContent).toBe(
      'не сошлось: лицевых 12, оборотов 11 — документ соберёте в редакторе',
    );
    expect(status.className).toContain('merge-screen__status--warning');
    expect(status.querySelector('.dot--warning')).not.toBeNull();
    expect(view.container.querySelector('.sort')?.className).toBe('sort');
  });

  it('лишние обороты названы и не потеряны; иллюстрация та же', () => {
    const view = renderMerge(sets(12, 13));

    expect(screen.getByRole('status').textContent).toBe(
      'лишних оборотов: 1 — документ соберёте в редакторе',
    );
    expect(view.container.querySelector('.sort')?.className).toBe('sort');
  });

  it('принятый коротким проход — свой статус, янтарный', () => {
    const view = renderMerge(sets(12, 7, { backsState: 'accepted' }));

    expect(screen.getByRole('status').textContent).toBe(
      'проход оборотов принят коротким: лицевых 12, оборотов 7',
    );
    expect(screen.getByRole('status').className).toContain('--warning');
    expect(view.container.querySelector('.sort')?.className).toBe('sort');
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

  it('B-5: хвост про пустые обороты — отдельным узлом, основное не перерисовывается', () => {
    const view = renderMerge(report({ fronts: 7, backs: 7 }), {
      mode: 'hide',
      found: 0,
      hidden: 0,
      pending: 2,
    });

    expect(view.container.querySelector('.merge-screen__main')?.textContent).toBe('совпало пар: 7');
    expect(view.container.querySelector('.merge-screen__tail')?.textContent).toBe(
      ' · ищем пустые обороты…',
    );
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
  });

  it('M6: хвост выравнивания — «ещё N стр.» пока идёт, затем «выровнено: N»; узел по виду, счёт без перемонтирования', () => {
    const view = renderMergeStraight(
      report({ fronts: 7, backs: 7 }),
      straightenOf({ pending: 5, straightened: 2, total: 14 }),
      { mode: 'hide', found: 2, hidden: 2, pending: 0 },
    );
    expect(screen.getByRole('status').textContent).toBe(
      'совпало пар: 7 · пустых оборотов: 2 · выравнивание: ещё 5 стр.',
    );
    const tails = view.container.querySelectorAll('.merge-screen__tail');
    expect(tails).toHaveLength(2);
    const pendingNode = tails[1];

    // Счёт меняется — тот же узел (без проявления); итог — новый узел.
    view.rerender(
      <MergeScreen
        assembly={{
          ...assemblyFor(report({ fronts: 7, backs: 7 }), {
            mode: 'hide',
            found: 2,
            hidden: 2,
            pending: 0,
          }),
          straighten: straightenOf({ pending: 1, straightened: 6, total: 14 }),
        }}
      />,
    );
    expect(view.container.querySelectorAll('.merge-screen__tail')[1]).toBe(pendingNode);
    expect(pendingNode?.textContent).toBe(' · выравнивание: ещё 1 стр.');

    view.rerender(
      <MergeScreen
        assembly={{
          ...assemblyFor(report({ fronts: 7, backs: 7 }), {
            mode: 'hide',
            found: 2,
            hidden: 2,
            pending: 0,
          }),
          straighten: straightenOf({ straightened: 7, level: 7, total: 14 }),
        }}
      />,
    );
    const done = view.container.querySelectorAll('.merge-screen__tail')[1];
    expect(done).not.toBe(pendingNode);
    expect(done?.textContent).toBe(' · выровнено: 7 стр.');
  });

  it('M6: хвоста нет при «Не трогать», в режиме наборов и когда статусов нет', () => {
    renderMergeStraight(report({ fronts: 7, backs: 7 }), straightenOf({ pending: 3 }, 'off'));
    expect(screen.getByRole('status').textContent).toBe('совпало пар: 7');
    cleanup();

    renderMergeStraight(sets(12, 11), straightenOf({ pending: 3, total: 23 }));
    expect(screen.getByRole('status').textContent).not.toContain('выравнивание');
    cleanup();

    renderMergeStraight(
      report({ backs: 0, backsState: null, backsDeclined: true }),
      straightenOf({ total: 0 }),
    );
    expect(screen.getByRole('status').textContent).not.toContain('выровнено');
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
      block.push({
        key,
        side,
        sheet,
        angle: 0,
        lost: false,
        addedSet: 1,
        blank: null,
        straighten: NO_STRAIGHTEN_MARK,
      });
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

  it('совпало: тег «НАБОР Д1», заголовок набора, иллюстрация «пары», статус по набору', () => {
    const view = render(<MergeScreen assembly={withSet(setReport({}))} set={1} />);

    expect(view.container.querySelector('.merge-screen__tag')?.textContent).toBe('НАБОР Д1');
    expect(title()).toBe('Сопоставляем лица и обороты набора');
    expect(view.container.querySelector('.sort')?.className).toBe('sort');
    expect(screen.getByRole('status').textContent).toBe('набор Д1: совпало пар 3');
  });

  it('не сошлось: янтарная строка с числами, иллюстрация та же', () => {
    const view = render(
      <MergeScreen assembly={withSet(setReport({ backs: 2, mismatch: true }))} set={1} />,
    );

    expect(screen.getByRole('status').textContent).toBe('набор Д1: не сошлось — лиц 3, оборотов 2');
    expect(screen.getByRole('status').className).toContain('--warning');
    expect(view.container.querySelector('.sort')?.className).toBe('sort');
  });

  it('лишние обороты набора — янтарная строка, иллюстрация та же', () => {
    const view = render(
      <MergeScreen assembly={withSet(setReport({ backs: 4, mismatch: true }))} set={1} />,
    );

    expect(view.container.querySelector('.sort')?.className).toBe('sort');
    expect(screen.getByRole('status').className).toContain('--warning');
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
    const view = render(<MergeScreen assembly={withSet(setReport({}))} set={null} />);

    expect(view.container.querySelector('.merge-screen__tag')).toBeNull();
    expect(title()).toBe('Сопоставляем лица и обороты');
    expect(screen.getByRole('status').textContent).toBe('совпало пар: 12');
  });
});
