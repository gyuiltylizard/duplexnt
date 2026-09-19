import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';

// Глобалы vitest выключены, поэтому авто-очистка testing-library не срабатывает сама.
afterEach(cleanup);

describe('App', () => {
  it('монтируется в jsdom и отдаёт непустую разметку', () => {
    const { container } = render(<App />);

    expect(container.innerHTML).not.toBe('');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe("Duplexn't");
  });
});
