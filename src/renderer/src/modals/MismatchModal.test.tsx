import type { AssemblyReport } from '@shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { MismatchModal } from './MismatchModal';

/** Режим раздельных наборов (M3.6): проходы не сошлись, группы — по числам проходов. */
function report(
  fronts: number,
  backs: number,
  overrides: Partial<AssemblyReport> = {},
): AssemblyReport {
  return {
    mode: 'sets',
    groups: { fronts, backs, divider: fronts },
    sets: [],
    pendingSet: null,
    fronts,
    backs,
    backsState: 'completed',
    backsDeclined: false,
    mismatch: true,
    ...overrides,
  };
}

const text = (): string => document.getElementById('mismatch-text')?.textContent ?? '';

afterEach(cleanup);

describe('модалка mismatch (M3.6, S6: три исхода про режим наборов)', () => {
  it('B-11: Esc — как «Понятно»', () => {
    const onClose = vi.fn();
    render(<MismatchModal report={report(12, 11)} onClose={onClose} />);

    fireEvent.keyDown(screen.getByRole('button', { name: 'Понятно' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('оборотов меньше: числа проходов, режим объяснён, три шага, лист не назван; одно действие «Понятно»', () => {
    const onClose = vi.fn();
    render(<MismatchModal report={report(12, 11)} onClose={onClose} />);

    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByText('НЕ СХОДЯТСЯ ПРОХОДЫ')).toBeDefined();
    expect(screen.getByText('Лицевых сторон 12, оборотов — 11')).toBeDefined();
    expect(text()).toContain('Документ пока не собран: лица и обороты лежат отдельными наборами');
    expect(text()).toContain('досканируйте недостающий кнопкой «+ Добавить»');
    expect(text()).toContain('нажмите «Собрать документ»');
    expect(text()).not.toMatch(/лист №/u);

    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(1);
    fireEvent.click(buttons[0] as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('оборотов больше: текст про двойной захват, лишний оборот в наборе и «Собрать документ»', () => {
    render(<MismatchModal report={report(12, 13)} onClose={vi.fn()} />);

    expect(screen.getByText('Оборотов больше, чем лицевых сторон: 13 против 12')).toBeDefined();
    expect(text()).toContain('Найдите лишний оборот в наборе и удалите его');
    expect(text()).toContain('нажмите «Собрать документ»');
  });

  it('проход принят коротким: свой заголовок, про недостающие обороты', () => {
    render(<MismatchModal report={report(12, 7, { backsState: 'accepted' })} onClose={vi.fn()} />);

    expect(screen.getByText('Проход оборотов остановлен: 7 из 12')).toBeDefined();
    expect(text()).toContain('Досканируйте недостающие обороты кнопкой «+ Добавить»');
    expect(text()).not.toMatch(/№/u);
  });

  it('принят длинным (лишние обороты): текст про лишние, без недостающих', () => {
    render(<MismatchModal report={report(3, 5, { backsState: 'accepted' })} onClose={vi.fn()} />);

    expect(screen.getByText('Проход оборотов остановлен: 5 из 3')).toBeDefined();
    expect(text()).toContain('лишние обороты — в наборе оборотов');
    expect(text()).not.toContain('недостающие');
  });

  it('начальный фокус — на «Понятно»', () => {
    render(<MismatchModal report={report(12, 11)} onClose={vi.fn()} />);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Понятно' }));
  });
});
