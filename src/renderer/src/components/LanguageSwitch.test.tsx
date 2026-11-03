import { fail, ok, type Locale, type Result } from '@shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { LanguageSwitch } from './LanguageSwitch';

// Переключатель языка (B-41, U6; handoff 2026-11-b41-language, Behaviour): выделение из снимка,
// одна команда на выбор, игнор повторов и текущего, отказ — прежний язык и тост.

afterEach(() => {
  cleanup();
});

/** Ответ команды, который разрешается, когда скажет тест — чтобы поймать состояние ожидания. */
function deferred() {
  let resolve: (result: Result<void>) => void = () => undefined;
  const promise = new Promise<Result<void>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderSwitch(
  language: Locale,
  onChange: (locale: Locale) => Promise<Result<void>> = vi.fn(() => Promise.resolve(ok(undefined))),
) {
  const onFailed = vi.fn();
  const view = render(
    <LanguageSwitch language={language} onChange={onChange} onFailed={onFailed} />,
  );
  const option = (name: string) => screen.getByRole<HTMLButtonElement>('radio', { name });
  return { view, onChange, onFailed, option };
}

describe('LanguageSwitch', () => {
  it('показывает текущий язык из снимка; подписи на своих языках с атрибутом lang', () => {
    const { option } = renderSwitch('ru');
    const group = screen.getByRole('radiogroup', { name: 'Язык' });
    expect(group.getAttribute('aria-busy')).toBeNull();
    expect(option('Русский').getAttribute('aria-checked')).toBe('true');
    expect(option('English').getAttribute('aria-checked')).toBe('false');
    expect(option('Русский').getAttribute('lang')).toBe('ru');
    expect(option('English').getAttribute('lang')).toBe('en');
  });

  it('выбор другого языка шлёт одну команду; повторный выбор текущего не шлёт', () => {
    const { option, onChange } = renderSwitch('ru');
    fireEvent.click(option('Русский'));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(option('English'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('en');
  });

  it('пока идёт запись — группа занята, нажатая опция ждёт, выделение прежнее, второй клик игнорируется', async () => {
    const { promise, resolve } = deferred();
    const { option, onChange, view } = renderSwitch(
      'ru',
      vi.fn(() => promise),
    );
    fireEvent.click(option('English'));
    fireEvent.click(option('English'));
    fireEvent.click(option('Русский'));

    expect(onChange).toHaveBeenCalledOnce();
    expect(screen.getByRole('radiogroup').getAttribute('aria-busy')).toBe('true');
    expect(option('English').className).toContain('lang-switch__opt--pending');
    expect(option('Русский').getAttribute('aria-checked')).toBe('true');

    // Запись удалась, снимок принёс новый язык: ожидание снято, фокус на выбранной опции.
    await act(async () => {
      resolve(ok(undefined));
      await promise;
    });
    view.rerender(<LanguageSwitch language="en" onChange={onChange} onFailed={vi.fn()} />);
    expect(screen.getByRole('radiogroup').getAttribute('aria-busy')).toBeNull();
    expect(option('English').getAttribute('aria-checked')).toBe('true');
    expect(option('English').className).not.toContain('pending');
    expect(document.activeElement).toBe(option('English'));
  });

  it('отказ записи: ожидание снято, выделение прежнее, вызывающий уведомлён', async () => {
    const onChange = vi.fn(() => Promise.resolve(fail('storageFailed', { reason: 'schema' })));
    const { option, onFailed } = renderSwitch('ru', onChange);
    await act(async () => {
      fireEvent.click(option('English'));
      await Promise.resolve();
    });
    expect(onFailed).toHaveBeenCalledOnce();
    expect(screen.getByRole('radiogroup').getAttribute('aria-busy')).toBeNull();
    expect(option('Русский').getAttribute('aria-checked')).toBe('true');
    expect(option('English').className).not.toContain('pending');
  });

  it('исключение моста — как отказ', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onChange = vi.fn(() => Promise.reject(new Error('мост упал')));
    const { option, onFailed } = renderSwitch('ru', onChange);
    await act(async () => {
      fireEvent.click(option('English'));
      await Promise.resolve();
    });
    expect(onFailed).toHaveBeenCalledOnce();
    expect(screen.getByRole('radiogroup').getAttribute('aria-busy')).toBeNull();
    error.mockRestore();
  });
});
