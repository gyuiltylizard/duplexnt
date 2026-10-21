import type { AssemblyReport } from '@shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { MismatchModal } from './MismatchModal';

function report(overrides: Partial<AssemblyReport>): AssemblyReport {
  return {
    mode: 'sets',
    groups: { fronts: 12, backs: 11, divider: 12 },
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

describe('модалка mismatch (M3.5, S8: честный Copy трёх исходов)', () => {
  it('оборотов меньше: фактические числа, лист не назван, отсылка к «+ Добавить»; одно действие «Понятно»', () => {
    const onClose = vi.fn();
    render(<MismatchModal report={report({})} onClose={onClose} />);

    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByText('В первом проходе 12 листов, во втором — 11')).toBeDefined();
    const text = document.getElementById('mismatch-text')?.textContent ?? '';
    expect(text).toContain('Какой именно лист остался без оборота, приложение не знает');
    expect(text).toContain('Нужен оборот — добавьте его кнопкой «+ Добавить».');
    expect(text).not.toMatch(/лист №/u);

    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(1);
    fireEvent.click(buttons[0] as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('оборотов больше: текст про двойной захват, конец набора и «+ Добавить» для лица', () => {
    render(
      <MismatchModal
        report={report({ backs: 13, pairs: 12, unpairedSheets: [], extraBacks: 1 })}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByText('Во втором проходе страниц больше, чем листов: 13 против 12'),
    ).toBeDefined();
    const text = document.getElementById('mismatch-text')?.textContent ?? '';
    expect(text).toContain('лишние лежат в конце набора');
    expect(text).toContain('Нужно лицо — добавьте его кнопкой «+ Добавить».');
  });

  it('проход принят коротким: свой заголовок, листы без пары не перечисляются', () => {
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
    const text = document.getElementById('mismatch-text')?.textContent ?? '';
    expect(text).toContain('Листы без пары помечены в ленте');
    expect(text).toContain('Нужны обороты — добавьте их кнопкой «+ Добавить».');
    expect(text).not.toMatch(/№/u);
  });

  it('принят длинным (лишние обороты, непарных лиц нет): текст без листов без пары и без «+ Добавить»', () => {
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
    const text = document.getElementById('mismatch-text')?.textContent ?? '';
    expect(text).toContain('лишние обороты лежат в конце набора');
    expect(text).not.toContain('без пары');
    expect(text).not.toContain('Добавить');
  });

  it('начальный фокус — на «Понятно»', () => {
    render(<MismatchModal report={report({})} onClose={vi.fn()} />);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Понятно' }));
  });
});
