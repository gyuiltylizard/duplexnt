import type { AssemblyReport } from '@shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { i18n } from '../i18n';
import { MismatchModal, sheetsLabel } from './MismatchModal';

function report(overrides: Partial<AssemblyReport>): AssemblyReport {
  return {
    fronts: 12,
    backs: 11,
    pairs: 11,
    unpairedSheets: [1],
    extraBacks: 0,
    backsState: 'completed',
    backsDeclined: false,
    mismatch: true,
    ...overrides,
  };
}

afterEach(cleanup);

describe('модалка mismatch', () => {
  it('оборотов меньше: фактические числа и названный лист; одно действие «Понятно»', () => {
    const onClose = vi.fn();
    render(<MismatchModal report={report({})} onClose={onClose} />);

    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByText('В первом проходе 12 листов, во втором — 11')).toBeDefined();
    expect(screen.getByText(/Без оборота: лист №1 — в ленте он помечен/)).toBeDefined();
    // Отсылки к «Добавить» нет намеренно: его нет до M3.
    expect(screen.queryByText(/Добавить/)).toBeNull();

    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(1);
    fireEvent.click(buttons[0] as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('оборотов больше: текст про двойной захват и конец набора', () => {
    render(
      <MismatchModal
        report={report({ backs: 13, pairs: 12, unpairedSheets: [], extraBacks: 1 })}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByText('Во втором проходе страниц больше, чем листов: 13 против 12'),
    ).toBeDefined();
    expect(screen.getByText(/лишние лежат в конце набора/)).toBeDefined();
  });

  it('проход принят коротким: свой заголовок и перечень листов', () => {
    render(
      <MismatchModal
        report={report({
          backs: 7,
          pairs: 7,
          unpairedSheets: [1, 2, 3, 4, 5],
          backsState: 'accepted',
        })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Проход оборотов остановлен: 7 из 12')).toBeDefined();
    expect(
      screen.getByText(/Без оборота: листы №1–5 — в ленте такие листы помечены/),
    ).toBeDefined();
  });

  it('принят длинным (лишние обороты, непарных лиц нет): текст без пустого перечня листов', () => {
    render(
      <MismatchModal
        report={report({
          backs: 5,
          fronts: 3,
          pairs: 3,
          unpairedSheets: [],
          extraBacks: 2,
          backsState: 'accepted',
        })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Проход оборотов остановлен: 5 из 3')).toBeDefined();
    expect(screen.getByText(/лишние обороты лежат в конце набора/)).toBeDefined();
    expect(screen.queryByText(/Без оборота/)).toBeNull();
  });

  it('начальный фокус — на «Понятно»', () => {
    render(<MismatchModal report={report({})} onClose={vi.fn()} />);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Понятно' }));
  });
});

describe('sheetsLabel', () => {
  it.each([
    [[1], 'лист №1'],
    [[1, 2, 3, 4, 5], 'листы №1–5'],
    [[1, 4], 'листы №1, 4'],
    [[1, 2], 'листы №1, 2'],
    [[1, 2, 3, 5], 'листы №1–3, 5'],
  ])('%j → %s', (sheets, expected) => {
    expect(sheetsLabel(i18n.t.bind(i18n), sheets)).toBe(expected);
  });
});
