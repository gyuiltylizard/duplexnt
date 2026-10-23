import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { makePass, makeSnapshot, option, pages, renderEditor, stubApi } from './editor-fixture';

// Страницы двустороннего набора в редакторе (план M4.5, U6; R13, R14; handoff M4.5, S8, S10):
// теги «Д1» на обеих сторонах и «об» на обороте, подписи с листом внутри набора (в подблоках —
// без), ДЕТАЛИ с проходом пары, плашка прерванного прохода набора, карточки `add`.

/** Пары 3+3 плюс набор «Д1» после лица 2: 3 лица и `backs` оборотов. */
function withPair(backs: number, backsState: 'completed' | 'interrupted' = 'completed') {
  return makeSnapshot([
    makePass({ pages: pages(3) }),
    makePass({ number: 2, kind: 'backs', pages: pages(3, 1, 'p02-s01') }),
    makePass({
      number: 3,
      kind: 'addedFronts',
      after: 'p01-s01-0002',
      backsDecision: 'none',
      pages: pages(3, 1, 'p03-s01'),
    }),
    makePass({
      number: 4,
      kind: 'addedBacks',
      pair: 3,
      state: backsState,
      pages: pages(backs, 1, 'p04-s01'),
    }),
  ]);
}

const facts = (): string[] =>
  screen
    .getAllByRole('term')
    .map((term) => `${term.textContent}: ${term.nextElementSibling?.textContent ?? ''}`);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('страницы пары в ленте (S8)', () => {
  it('чередование: лицо и оборот листа набора с тегами «Д1» и «об», подписи с листом', () => {
    stubApi();
    renderEditor(withPair(3));

    // Лента: 1л 1о 2л [f1 b1 f2 b2 f3 b3] 2о 3л 3о.
    const front = option(3);
    const back = option(4);
    expect(front.getAttribute('data-key')).toBe('p03-s01-0001');
    expect(back.getAttribute('data-key')).toBe('p04-s01-0003');
    expect(front.getAttribute('aria-label')).toBe('Страница 4, лицо листа 1 набора Д1');
    expect(back.getAttribute('aria-label')).toBe('Страница 5, оборот листа 1 набора Д1');
    expect(within(front).getByText('Д1').className).toBe('thumb__tag thumb__tag--added');
    expect(within(front).queryByText('об')).toBeNull();
    const tags = [...back.querySelectorAll('.thumb__tag')].map((tag) => tag.textContent);
    expect(tags).toEqual(['Д1', 'об']);
    // Обороты основной пачки — только «об».
    expect([...option(1).querySelectorAll('.thumb__tag')].map((tag) => tag.textContent)).toEqual([
      'об',
    ]);
  });

  it('подблоки несовпавшего набора: подписи без листа, лица в порядке сканирования, обороты — обратном', () => {
    stubApi();
    renderEditor(withPair(2));

    // Лента: 1л 1о 2л [f1 f2 f3 | b2 b1] 2о 3л 3о.
    expect(
      screen
        .getAllByRole('option')
        .slice(3, 8)
        .map((item) => item.getAttribute('data-key')),
    ).toEqual(['p03-s01-0001', 'p03-s01-0002', 'p03-s01-0003', 'p04-s01-0002', 'p04-s01-0001']);
    expect(option(3).getAttribute('aria-label')).toBe('Страница 4, лицевая набора Д1');
    expect(option(6).getAttribute('aria-label')).toBe('Страница 7, оборотная набора Д1');
  });

  it('ДЕТАЛИ оборота набора: набор, лист, сторона, проход оборотов набора, пояснение про пару', () => {
    stubApi();
    renderEditor(withPair(3));

    fireEvent.click(option(4));
    fireEvent.click(screen.getByRole('button', { name: /ДЕТАЛИ/ }));
    expect(
      screen.getByRole('heading', { name: 'Стр. 5 — оборот листа 1 набора Д1' }),
    ).toBeDefined();
    expect(facts()).toEqual([
      'Набор: добавленный №1',
      'Лист: №1',
      'Сторона: оборот',
      'Откуда: проход оборотов набора Д1',
      'Поворот: 0°',
    ]);
    expect(
      screen.getByText(
        'Страница двустороннего набора: оборот сопоставлен с лицом по позиции в проходе оборотов набора.',
      ),
    ).toBeDefined();
  });

  it('ДЕТАЛИ лица в подблоке: лист «—», проход лиц набора, пояснение про подблоки', () => {
    stubApi();
    renderEditor(withPair(2));

    fireEvent.click(option(3));
    fireEvent.click(screen.getByRole('button', { name: /ДЕТАЛИ/ }));
    expect(screen.getByRole('heading', { name: 'Стр. 4 — лицевая набора Д1' })).toBeDefined();
    expect(facts()).toEqual([
      'Набор: добавленный №1',
      'Лист: —',
      'Сторона: лицо',
      'Откуда: проход лиц набора Д1',
      'Поворот: 0°',
    ]);
    expect(screen.getByText(/Обороты набора не сошлись с лицами/)).toBeDefined();
  });

  it('сводка add для текущей на странице пары — теми же словами', () => {
    stubApi();
    renderEditor({
      ...withPair(3),
      scanner: {
        kind: 'ready',
        scanner: { name: 'ScanPro 200', scheme: 'https', host: '192.0.2.10', port: 443 },
        options: { colorModes: ['Grayscale8'], resolutions: [300], paperSizes: ['A4'] },
        params: { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' },
      },
    });

    fireEvent.click(option(4));
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    expect(document.querySelector('.add-modal__summary')?.textContent).toBe(
      'Двустороннее · после стр. 5 (оборот листа 1 набора Д1)',
    );
  });
});

describe('плашка прерванного прохода набора (S10)', () => {
  it('обороты набора прерваны: заголовок с набором и ожиданием, текст про документ', () => {
    stubApi();
    renderEditor({ ...withPair(2, 'interrupted'), canResume: true, canAccept: true });

    expect(
      screen.getByRole('heading', { name: 'Обороты набора Д1 прервались после страницы 2 из 3' }),
    ).toBeDefined();
    expect(screen.getByText(/Полученные страницы уже в документе.*начиная с 3-го/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Досканировать остаток' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Оставить как есть' })).toBeDefined();
  });

  it('лица набора прерваны: заголовок называет набор; «+ Добавить» недоступна', () => {
    stubApi();
    renderEditor({
      ...makeSnapshot([
        makePass({ pages: pages(3) }),
        makePass({ number: 2, kind: 'backs', pages: pages(3, 1, 'p02-s01') }),
        makePass({
          number: 3,
          kind: 'addedFronts',
          after: 'p01-s01-0002',
          backsDecision: 'none',
          state: 'interrupted',
          pages: pages(2, 1, 'p03-s01'),
        }),
      ]),
      canResume: true,
      canAccept: true,
    });

    expect(
      screen.getByRole('heading', { name: 'Лица набора Д1 прервались после страницы 2' }),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Добавить' }).hasAttribute('disabled')).toBe(true);
    // До оборотов набор показан односторонним блоком: тег «Д1» без «об».
    expect(option(3).getAttribute('aria-label')).toBe('Страница 4, лицевая набора Д1');
  });
});
