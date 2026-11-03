import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../i18n';
import { App } from '../App';
import { makeSnapshot, stubApi } from '../app-fixture';
import { applyLanguage, useLanguage } from './use-language';

// Язык из снимка (B-41, U3): применяется до первого кадра и при смене снимка; русский снимок
// (все остальные jsdom-тесты) ничего не меняет. После каждого теста — обратно на русский.

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage('ru');
  document.documentElement.lang = 'ru';
});

describe('applyLanguage', () => {
  it('меняет язык и <html lang>, повтор того же языка — без вызовов', () => {
    const target = {
      language: 'ru',
      changeLanguage: vi.fn((locale: string) => (target.language = locale)),
    };
    const root = { lang: 'ru' };

    applyLanguage('en', target, root);
    expect(target.changeLanguage).toHaveBeenCalledExactlyOnceWith('en');
    expect(root.lang).toBe('en');

    applyLanguage('en', target, root);
    expect(target.changeLanguage).toHaveBeenCalledOnce();
  });

  it('с настоящим i18n язык меняется синхронно — ресурсы вшиты', () => {
    applyLanguage('en');
    expect(i18n.language).toBe('en');
    expect(i18n.t('setup.start')).toBe('Scan the front sides');
    expect(document.documentElement.lang).toBe('en');
  });
});

describe('useLanguage', () => {
  function Probe({ language }: { language: 'ru' | 'en' | null }) {
    useLanguage(language);
    return <p>{i18n.t('setup.start')}</p>;
  }

  it('null — снимка нет — ничего не трогает', () => {
    render(<Probe language={null} />);
    expect(i18n.language).toBe('ru');
    expect(document.documentElement.lang).toBe('ru');
  });

  it('смена снимка меняет язык без перезагрузки, русский возвращает обратно', () => {
    const view = render(<Probe language="en" />);
    expect(i18n.language).toBe('en');
    expect(document.documentElement.lang).toBe('en');

    view.rerender(<Probe language="ru" />);
    expect(i18n.language).toBe('ru');
    expect(document.documentElement.lang).toBe('ru');
  });
});

describe('App с английским снимком', () => {
  it('первый экран — по-английски, <html lang="en">', async () => {
    stubApi(makeSnapshot({ language: 'en' }));
    render(<App />);

    expect(
      await screen.findByRole('heading', { name: 'Scanning both sides in two passes' }),
    ).toBeDefined();
    expect(document.documentElement.lang).toBe('en');
    expect(
      screen.queryByRole('heading', { name: 'Сканируем обе стороны в два прохода' }),
    ).toBeNull();
  });
});
