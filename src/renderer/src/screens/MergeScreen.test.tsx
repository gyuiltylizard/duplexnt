import type { AssembledPage, AssemblyReport, SessionAssembly } from '@shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import '../i18n';
import { MergeScreen } from './MergeScreen';

function report(overrides: Partial<AssemblyReport>): AssemblyReport {
  return {
    mode: 'pairs',
    groups: null,
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
    fronts,
    backs,
    mismatch: true,
    ...extra,
  });

/** Порядок под отчёт — как его строит ядро: пары чередованием, наборы — лица, затем обороты. */
function assemblyFor(assemblyReport: AssemblyReport): SessionAssembly {
  const order: AssembledPage[] = [];
  let key = 0;
  const push = (side: AssembledPage['side'], sheet: number | null): void => {
    key += 1;
    order.push({ key: `k${String(key)}`, side, sheet, angle: 0, lost: false, addedSet: null });
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
  };
}

function renderMerge(assemblyReport: AssemblyReport) {
  return render(<MergeScreen assembly={assemblyFor(assemblyReport)} />);
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

  it('органов управления нет, фокус — на контейнере экрана', () => {
    renderMerge(report({}));

    expect(screen.queryByRole('button')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });
});
