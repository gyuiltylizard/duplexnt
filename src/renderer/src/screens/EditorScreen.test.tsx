import { EMPTY_EDITS, fail } from '@shared';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { makePass, makeSnapshot, pages, renderEditor, stubApi, twoPass } from './editor-fixture';

// Экран `editor`: поведение M1–M2 (лента, превью, тумблер, точка несохранённого, плашка прохода).
// Правки, выделение, документы и инспектор M3 — в EditorScreen.edits.test.tsx; сохранение и
// новое сканирование — в EditorScreen.save.test.tsx; хелперы — editor-fixture.

/** Клавиша на текущей миниатюре — точке входа клавиатуры в ленту (роуминг tabindex). */
function pressOnCurrent(key: string): void {
  const current = document.querySelector('[role="option"][tabindex="0"]');
  if (current === null) {
    throw new Error('нет текущей миниатюры');
  }
  fireEvent.keyDown(current, { key });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('экран editor', () => {
  it('лента показывает все страницы, выбор миниатюры меняет превью и позицию', () => {
    stubApi();
    renderEditor(makeSnapshot([makePass({ pages: pages(4) })]));

    expect(screen.getAllByRole('option').length).toBe(4);
    expect(screen.getByText('стр. 1 из 4')).toBeDefined();
    expect(screen.getByText('1 из 4')).toBeDefined();

    fireEvent.click(screen.getAllByRole('option')[2] as Element);
    expect(screen.getByText('3 из 4')).toBeDefined();
    expect(screen.getByAltText('Страница 3')).toBeDefined();
  });

  it('AE1: лента — порядок сборки 1л, 1о, 2л, 2о, 3л, 3о с тегами «об» на оборотах', () => {
    stubApi();
    renderEditor(twoPass());

    const options = screen.getAllByRole('option');
    expect(options.length).toBe(6);
    // Лицо листа 1, затем его оборот — последняя страница второго прохода.
    expect(options[0]?.getAttribute('data-key')).toBe('p01-s01-0001');
    expect(options[1]?.getAttribute('data-key')).toBe('p02-s01-0003');
    expect(options[2]?.getAttribute('data-key')).toBe('p01-s01-0002');
    expect(options[5]?.getAttribute('data-key')).toBe('p02-s01-0001');
    // Теги «об» — на оборотах (позиции 2, 4, 6), номера — по порядку в наборе.
    expect((options[1] as Element).textContent).toContain('об');
    expect((options[0] as Element).textContent).not.toContain('об');
    expect((options[5] as Element).textContent).toContain('6');
  });

  it('S6: непарный лист несёт янтарную точку и aria-label «Лист N — без оборота»', () => {
    stubApi();
    renderEditor(twoPass(2));

    const options = screen.getAllByRole('option');
    // Обороты пришли от последнего листа: без оборота остался лист №1 (младший).
    expect(options[0]?.getAttribute('aria-label')).toBe('Лист 1 — без оборота');
    expect(
      (options[0] as Element).querySelector('[title="У этого листа нет оборота"]'),
    ).not.toBeNull();
    // Парные листы точки не несут.
    expect(options[1]?.getAttribute('aria-label')).toBe('Страница 2');
    expect(screen.getAllByTitle('У этого листа нет оборота').length).toBe(1);
  });

  it('S7: тумблер поворота виден при проходе оборотов и шлёт правку с текущими правками (M3)', () => {
    const api = stubApi();
    renderEditor(twoPass());

    const toggle = screen.getByRole('checkbox', { name: 'Повернуть обороты на 180°' });
    fireEvent.click(toggle);
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({ edits: EMPTY_EDITS, rotate180: true });
  });

  it('S7: включённый поворот разворачивает только обороты; выключение шлёт rotate180: false', () => {
    const api = stubApi();
    const snapshot = makeSnapshot([
      makePass({ pages: pages(2) }),
      makePass({ number: 2, rotate180: true, pages: pages(2, 1, 'p02-s01') }),
    ]);
    renderEditor(snapshot);

    const options = screen.getAllByRole('option');
    expect((options[1] as Element).className).toContain('thumb--angle-180');
    expect((options[0] as Element).className).not.toContain('thumb--angle-');

    const toggle = screen.getByRole('checkbox', { name: 'Повернуть обороты на 180°' });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({ edits: EMPTY_EDITS, rotate180: false });
  });

  it('без прохода оборотов тумблера нет', () => {
    stubApi();
    renderEditor(makeSnapshot([makePass({})]));

    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('S9: точка несохранённого видна при saved: false и исчезает при saved: true', () => {
    stubApi();
    const unsavedView = renderEditor(makeSnapshot([makePass({})]));
    expect(screen.getByTitle('Есть несохранённые изменения')).toBeDefined();
    unsavedView.view.unmount();

    renderEditor(makeSnapshot([makePass({})], {}, { saved: true }));
    expect(screen.queryByTitle('Есть несохранённые изменения')).toBeNull();
  });

  it('стрелки и Home/End двигают выбор по всей ленте', () => {
    stubApi();
    renderEditor(
      makeSnapshot([
        makePass({ pages: pages(2) }),
        makePass({ number: 2, pages: pages(2, 1, 'p02-s01') }),
      ]),
    );

    pressOnCurrent('ArrowRight');
    expect(screen.getByText('2 из 4')).toBeDefined();
    pressOnCurrent('ArrowRight');
    expect(screen.getByText('3 из 4')).toBeDefined();
    pressOnCurrent('Home');
    expect(screen.getByText('1 из 4')).toBeDefined();
    pressOnCurrent('End');
    expect(screen.getByText('4 из 4')).toBeDefined();
  });

  it('кнопки статус-бара листают страницы и упираются в края', () => {
    stubApi();
    renderEditor(makeSnapshot([makePass({ pages: pages(2) })]));

    const prev = screen.getByRole('button', { name: 'Предыдущая страница' });
    const next = screen.getByRole('button', { name: 'Следующая страница' });
    // На краю кнопка гаснет `aria-disabled`, но остаётся фокусируемой (не выбрасывает фокус).
    expect(prev.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(prev);
    expect(screen.getByText('1 из 2')).toBeDefined();

    fireEvent.click(next);
    expect(screen.getByText('2 из 2')).toBeDefined();
    expect(next.getAttribute('aria-disabled')).toBe('true');
    expect(prev.getAttribute('aria-disabled')).toBeNull();
  });

  it('прерванный проход показывает плашку: номер последней страницы и три действия', () => {
    stubApi();
    renderEditor(
      makeSnapshot([makePass({ state: 'interrupted', pages: pages(17) })], {
        canResume: true,
        canAccept: true,
      }),
    );

    expect(screen.getByText('Проход прервался после страницы 17')).toBeDefined();
    expect(screen.getByText(/начиная с 18-го/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Досканировать остаток' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Оставить как есть' })).toBeDefined();
  });

  it('неизвестные параметры: «Досканировать» не рисуется, причина названа текстом', () => {
    stubApi();
    renderEditor(
      makeSnapshot([makePass({ state: 'interrupted', paramsKnown: false, pages: pages(5) })], {
        canAccept: true,
      }),
    );

    expect(screen.queryByRole('button', { name: 'Досканировать остаток' })).toBeNull();
    expect(screen.getByText(/восстановлен по файлам/)).toBeDefined();
  });

  it('подключён не тот сканер: текст называет сканер прохода', () => {
    stubApi();
    renderEditor(
      makeSnapshot(
        [
          makePass({
            state: 'interrupted',
            scanner: { name: 'ScanPro 200', scheme: 'https', host: '192.0.2.10', port: 443 },
            pages: pages(5),
          }),
        ],
        { canAccept: true },
      ),
    );

    expect(screen.queryByRole('button', { name: 'Досканировать остаток' })).toBeNull();
    expect(
      screen.getByText(/только на том сканере, на котором начат проход: ScanPro 200/),
    ).toBeDefined();
  });

  it('принятый как есть проход не предлагает досканировать', () => {
    stubApi();
    renderEditor(makeSnapshot([makePass({ state: 'accepted', pages: pages(5) })]));

    expect(screen.queryByText('ПРОХОД ПРЕРВАН')).toBeNull();
  });

  it('«Оставить как есть» шлёт acceptPass; отказ показан строкой в плашке', async () => {
    const api = stubApi({
      acceptPass: vi.fn(() => Promise.resolve(fail('sessionConflict', { reason: 'passRunning' }))),
    });
    renderEditor(
      makeSnapshot([makePass({ state: 'interrupted', pages: pages(3) })], {
        canResume: true,
        canAccept: true,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Оставить как есть' }));
    expect(api.acceptPass).toHaveBeenCalledTimes(1);
    expect((await screen.findByRole('alert')).textContent).toContain('Сейчас идёт проход');
  });

  it('свежий отказ «Оставить как есть» виден и под висящим отказом досканирования', async () => {
    stubApi({
      acceptPass: vi.fn(() => Promise.resolve(fail('sessionConflict', { reason: 'passRunning' }))),
    });
    renderEditor(
      makeSnapshot([makePass({ state: 'interrupted', pages: pages(3) })], {
        canResume: true,
        canAccept: true,
      }),
      { resumeFailure: { code: 'scannerUnreachable' } },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Оставить как есть' }));
    await screen.findByText(/Сейчас идёт проход/);
    expect(screen.queryByText(/Досканировать не удалось/)).toBeNull();
  });

  it('отказ досканирования: текст по коду и ссылка «подключите заново»', () => {
    stubApi();
    const onOpenDevice = vi.fn();
    renderEditor(
      makeSnapshot([makePass({ state: 'interrupted', pages: pages(3) })], {
        canResume: true,
        scanner: {
          kind: 'unreachable',
          scanner: { name: 'ScanPro 200', scheme: 'https', host: '192.0.2.10', port: 443 },
          error: { code: 'scannerUnreachable' },
          params: { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' },
        },
      }),
      { resumeFailure: { code: 'scannerUnreachable' }, onOpenDevice },
    );

    expect(screen.getByRole('alert').textContent).toContain(
      'Досканировать не удалось: сканер не отвечает',
    );
    fireEvent.click(screen.getByRole('button', { name: 'подключите заново' }));
    expect(onOpenDevice).toHaveBeenCalledWith('192.0.2.10:443');
  });

  it('потерянная страница на своём месте, не построившаяся миниатюра отличима от неё', () => {
    stubApi();
    renderEditor(
      makeSnapshot([
        makePass({
          pages: [
            { key: 'p01-s01-0001', number: 1, lost: false },
            { key: 'p01-s01-0002', number: 2, lost: true },
            { key: 'p01-s01-0003', number: 3, lost: false },
          ],
        }),
      ]),
    );

    const options = screen.getAllByRole('option');
    expect((options[1] as Element).getAttribute('aria-label')).toBe('Страница 2, файл потерян');
    expect((options[1] as Element).textContent).toContain('ФАЙЛ ПОТЕРЯН');

    // Третья миниатюра не построилась — своя подпись, без пунктира потери. У миниатюр пустой
    // `alt` (подпись — номер в подвале), поэтому выборка по классу, а не по роли.
    const thumbImages = document.querySelectorAll('.thumb__img');
    fireEvent.error(thumbImages[1] as HTMLElement);
    expect((options[2] as Element).textContent).toContain('НЕТ МИНИАТЮРЫ');
  });

  it('выбор потерянной страницы показывает пунктирное превью с текстом', () => {
    stubApi();
    renderEditor(
      makeSnapshot([
        makePass({
          pages: [
            { key: 'p01-s01-0001', number: 1, lost: false },
            { key: 'p01-s01-0002', number: 2, lost: true },
          ],
        }),
      ]),
    );

    fireEvent.click(screen.getAllByRole('option')[1] as Element);
    expect(screen.getByText('СТРАНИЦА 2')).toBeDefined();
    expect(screen.getByText(/Запись о ней есть, а файла на диске нет/)).toBeDefined();
  });

  it('стрелки двигают фокус вместе с выбором (роуминг tabindex)', () => {
    stubApi();
    renderEditor(makeSnapshot([makePass({ pages: pages(3) })]));

    const options = screen.getAllByRole('option');
    expect(options[0]?.getAttribute('tabindex')).toBe('0');
    expect(options[1]?.getAttribute('tabindex')).toBe('-1');

    pressOnCurrent('ArrowRight');
    expect(document.activeElement).toBe(options[1]);
    expect(options[1]?.getAttribute('tabindex')).toBe('0');
    expect(options[0]?.getAttribute('tabindex')).toBe('-1');

    // ↑/↓ — синонимы ←/→.
    pressOnCurrent('ArrowDown');
    expect(document.activeElement).toBe(options[2]);
    pressOnCurrent('ArrowUp');
    expect(document.activeElement).toBe(options[1]);
  });

  it('Enter и Пробел на миниатюре выбирают её', () => {
    stubApi();
    renderEditor(makeSnapshot([makePass({ pages: pages(3) })]));

    const options = screen.getAllByRole('option');
    fireEvent.keyDown(options[2] as Element, { key: ' ' });
    expect(screen.getByText('3 из 3')).toBeDefined();
    fireEvent.keyDown(options[1] as Element, { key: 'Enter' });
    expect(screen.getByText('2 из 3')).toBeDefined();
  });

  it('плашка прерванного прохода несёт все три действия', () => {
    stubApi();
    renderEditor(
      makeSnapshot([makePass({ state: 'interrupted', pages: pages(3) })], {
        canResume: true,
        canAccept: true,
      }),
    );

    const banner = screen.getByRole('region', { name: /Проход прервался/ });
    const labels = within(banner)
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(labels).toEqual(['Досканировать остаток', 'Оставить как есть', 'Новое сканирование']);
  });

  it('«подключён не тот сканер»: ссылка ведёт в device с адресом сканера прохода', () => {
    stubApi();
    const onOpenDevice = vi.fn();
    renderEditor(
      makeSnapshot(
        [
          makePass({
            state: 'interrupted',
            scanner: { name: 'ScanPro 200', scheme: 'https', host: '192.0.2.77', port: 8443 },
            pages: pages(5),
          }),
        ],
        { canAccept: true },
      ),
      { onOpenDevice },
    );

    fireEvent.click(screen.getByRole('button', { name: 'подключите заново' }));
    expect(onOpenDevice).toHaveBeenCalledExactlyOnceWith('192.0.2.77:8443');
  });

  it('страница, которая не открылась в превью, — текст вместо листа', () => {
    stubApi();
    renderEditor(makeSnapshot([makePass({ pages: pages(2) })]));

    fireEvent.error(screen.getByAltText('Страница 1'));
    expect(screen.getByText(/Страницу не удалось показать/)).toBeDefined();
    expect(screen.getByText('СТРАНИЦА 1')).toBeDefined();
  });

  it('элементов вех после M3 нет в разметке: «Добавить», «Пересканировать», пустые обороты', () => {
    stubApi();
    renderEditor(makeSnapshot([makePass({})]));

    expect(screen.queryByText(/Добавить/)).toBeNull();
    expect(screen.queryByText(/Пересканировать/)).toBeNull();
    expect(screen.queryByText(/пустые/)).toBeNull();
  });
});
