import type { AssemblyReport } from '@shared';
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

afterEach(cleanup);

describe('экран merge', () => {
  it('статусная строка — фактический результат, не константа', () => {
    render(<MergeScreen report={report({ pairs: 7, fronts: 7, backs: 7 })} />);

    expect(screen.getByRole('status').textContent).toBe('совпало пар: 7');
    expect(screen.getByText('Порядок восстановлен: лист N ← лицо N + оборот N')).toBeDefined();
  });

  it('при несовпадении статус сообщает о нём первым, формула меняется', () => {
    const view = render(
      <MergeScreen
        report={report({ backs: 11, pairs: 11, unpairedSheets: [1], mismatch: true })}
      />,
    );

    expect(screen.getByRole('status').textContent).toBe('не сошлось: лицевых 12, оборотов 11');
    expect(screen.getByText('Пары не сошлись — документ собран по совпавшим')).toBeDefined();
    // Ряд «документ» повторяет фактическую сборку: непарное лицо в начале, не чередование.
    const docCells = view.container.querySelectorAll('.merge-screen__cells--document > *');
    expect(docCells.length).toBe(23);
    expect(docCells[0]?.className).not.toContain('doc-cell--back');
    expect(docCells[1]?.className).not.toContain('doc-cell--back');
    expect(docCells[2]?.className).toContain('doc-cell--back');
  });

  it('лишние обороты названы и не потеряны', () => {
    render(
      <MergeScreen report={report({ backs: 13, pairs: 12, extraBacks: 1, mismatch: true })} />,
    );

    expect(screen.getByRole('status').textContent).toBe('лишних оборотов: 1 — в конце набора');
  });

  it('принятый коротким проход — свой статус', () => {
    render(
      <MergeScreen
        report={report({
          backs: 7,
          pairs: 7,
          unpairedSheets: [1, 2, 3, 4, 5],
          backsState: 'accepted',
          mismatch: true,
        })}
      />,
    );

    expect(screen.getByRole('status').textContent).toBe(
      'проход оборотов принят коротким · пар: 7 из 12',
    );
  });

  it('«Обороты не нужны»: ряд оборотов не рендерится, статус frontsOnly, формулы нет', () => {
    const view = render(
      <MergeScreen
        report={report({ backs: 0, pairs: 0, backsState: null, backsDeclined: true })}
      />,
    );

    expect(screen.getByRole('status').textContent).toBe('обороты не нужны · страниц: 12');
    expect(screen.queryByText(/обороты \d/)).toBeNull();
    expect(screen.queryByText(/Порядок восстановлен/)).toBeNull();
    expect(view.container.querySelector('.merge-screen__cell--back')).toBeNull();
  });

  it('органов управления нет, фокус — на контейнере экрана', () => {
    render(<MergeScreen report={report({})} />);

    expect(screen.queryByRole('button')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });
});
