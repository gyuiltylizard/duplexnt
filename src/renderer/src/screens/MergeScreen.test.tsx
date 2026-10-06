import type { AssembledPage, AssemblyReport, SessionAssembly } from '@shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import '../i18n';
import { MergeScreen } from './MergeScreen';

function report(overrides: Partial<AssemblyReport>): AssemblyReport {
  return {
    fronts: 12,
    backs: 12,
    pairs: 12,
    unpairedSheets: [],
    extraBacks: 0,
    backsState: 'completed',
    backsDeclined: false,
    mismatch: false,
    ...overrides,
  };
}

/** Порядок под отчёт — как его строит ядро: непарные лица, пары, лишние обороты в конце. */
function assemblyFor(assemblyReport: AssemblyReport): SessionAssembly {
  const order: AssembledPage[] = [];
  let key = 0;
  const push = (side: AssembledPage['side'], sheet: number | null): void => {
    key += 1;
    order.push({ key: `k${key}`, side, sheet, angle: 0, lost: false, unpaired: false });
  };
  for (const sheet of assemblyReport.unpairedSheets) {
    push('front', sheet);
  }
  for (let pair = 0; pair < assemblyReport.pairs; pair += 1) {
    push('front', pair + 1);
    push('back', pair + 1);
  }
  for (let extra = 0; extra < assemblyReport.extraBacks; extra += 1) {
    push('back', null);
  }
  if (order.length === 0) {
    for (let sheet = 1; sheet <= assemblyReport.fronts; sheet += 1) {
      push('front', sheet);
    }
  }
  return {
    order,
    documents: [{ name: '', start: 0, count: order.length }],
    orderEdited: false,
    hasEdits: false,
    deleted: 0,
    report: assemblyReport,
  };
}

function renderMerge(overrides: Partial<AssemblyReport>) {
  return render(<MergeScreen assembly={assemblyFor(report(overrides))} />);
}

afterEach(cleanup);

describe('экран merge', () => {
  it('статусная строка — фактический результат, не константа', () => {
    renderMerge({ pairs: 7, fronts: 7, backs: 7 });

    expect(screen.getByRole('status').textContent).toBe('совпало пар: 7');
    expect(screen.getByText('Порядок восстановлен: лист N ← лицо N + оборот N')).toBeDefined();
  });

  it('при несовпадении статус сообщает о нём первым, формула меняется', () => {
    const view = renderMerge({ backs: 11, pairs: 11, unpairedSheets: [1], mismatch: true });

    expect(screen.getByRole('status').textContent).toBe('не сошлось: лицевых 12, оборотов 11');
    expect(screen.getByText('Пары не сошлись — документ собран по совпавшим')).toBeDefined();
    // Ряд «документ» повторяет фактический порядок сборки: непарное лицо в начале.
    const docCells = view.container.querySelectorAll('.merge-screen__cells--document > *');
    expect(docCells.length).toBe(23);
    expect(docCells[0]?.className).not.toContain('doc-cell--back');
    expect(docCells[1]?.className).not.toContain('doc-cell--back');
    expect(docCells[2]?.className).toContain('doc-cell--back');
  });

  it('лишние обороты названы и не потеряны', () => {
    renderMerge({ backs: 13, pairs: 12, extraBacks: 1, mismatch: true });

    expect(screen.getByRole('status').textContent).toBe('лишних оборотов: 1 — в конце набора');
  });

  it('принятый коротким проход — свой статус', () => {
    renderMerge({
      backs: 7,
      pairs: 7,
      unpairedSheets: [1, 2, 3, 4, 5],
      backsState: 'accepted',
      mismatch: true,
    });

    expect(screen.getByRole('status').textContent).toBe(
      'проход оборотов принят коротким · пар: 7 из 12',
    );
  });

  it('длинный набор: ряд «документ» упирается в потолок ячеек', () => {
    const view = renderMerge({ fronts: 40, backs: 40, pairs: 40 });

    const docCells = view.container.querySelectorAll('.merge-screen__cells--document > *');
    expect(docCells.length).toBe(24);
  });

  it('«Обороты не нужны»: ряд оборотов не рендерится, статус frontsOnly, формулы нет', () => {
    const view = renderMerge({ backs: 0, pairs: 0, backsState: null, backsDeclined: true });

    expect(screen.getByRole('status').textContent).toBe('обороты не нужны · страниц: 12');
    expect(screen.queryByText(/обороты \d/)).toBeNull();
    expect(screen.queryByText(/Порядок восстановлен/)).toBeNull();
    expect(view.container.querySelector('.merge-screen__cell--back')).toBeNull();
    expect(view.container.querySelector('.merge-screen__doc-cell--back')).toBeNull();
  });

  it('органов управления нет, фокус — на контейнере экрана', () => {
    renderMerge({});

    expect(screen.queryByRole('button')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });
});
