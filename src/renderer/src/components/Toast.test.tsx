import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toast } from './Toast';

// Тост (UI_SPEC раздел 8; handoff M3, S18): срок показа и необязательная кнопка действия.

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('тост', () => {
  it('без действия — только текст; срок вышел — владелец убирает', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    render(<Toast text="Страница удалена" onExpire={onExpire} />);

    expect(screen.getByRole('status').textContent).toBe('Страница удалена');
    expect(screen.queryByRole('button')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(2600);
    });
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('S18: кнопка выполняет действие и убирает тост', () => {
    const onExpire = vi.fn();
    const onClick = vi.fn();
    render(
      <Toast
        text="Сохранено 3 файла → C:\Сканы"
        durationMs={6000}
        action={{ label: 'Новое сканирование', onClick }}
        onExpire={onExpire}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Новое сканирование' }));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
