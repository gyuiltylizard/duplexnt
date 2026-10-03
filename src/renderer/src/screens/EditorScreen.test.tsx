import { fail, ok, type Api, type PassSnapshot, type Snapshot } from '@shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { EditorScreen } from './EditorScreen';

function pages(count: number, from = 1): { key: string; number: number; lost: boolean }[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `p01-s01-${String(from + index).padStart(4, '0')}`,
    number: from + index,
    lost: false,
  }));
}

function makePass(overrides: Partial<PassSnapshot>): PassSnapshot {
  return {
    number: 1,
    state: 'completed',
    paramsKnown: true,
    scanner: null,
    pages: pages(3),
    ...overrides,
  };
}

function makeSnapshot(passes: PassSnapshot[], overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    seq: 1,
    scanner: { kind: 'none' },
    session: { id: 'session.x', passes },
    pass: null,
    canResume: false,
    canAccept: false,
    storage: { incompatible: false, unsaved: false },
    notices: [],
    ...overrides,
  };
}

function stubApi(overrides: Partial<Record<keyof Api, unknown>> = {}) {
  const api = {
    acceptPass: vi.fn(() => Promise.resolve(ok(undefined))),
    closeSession: vi.fn(() => Promise.resolve(ok(undefined))),
    ...overrides,
  } as unknown as Api;
  vi.stubGlobal('api', api);
  return api;
}

function renderEditor(
  snapshot: Snapshot,
  overrides: Partial<Parameters<typeof EditorScreen>[0]> = {},
) {
  if (snapshot.session === null) {
    throw new Error('в фикстуре нет сессии');
  }
  return render(
    <EditorScreen
      snapshot={snapshot}
      session={snapshot.session}
      resumeFailure={null}
      onResume={vi.fn()}
      onOpenDevice={vi.fn()}
      {...overrides}
    />,
  );
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
    expect(screen.getByText('4 страницы')).toBeDefined();
    expect(screen.getByText('1 из 4')).toBeDefined();

    fireEvent.click(screen.getAllByRole('option')[2] as Element);
    expect(screen.getByText('3 из 4')).toBeDefined();
    expect(screen.getByAltText('Страница 3')).toBeDefined();
  });

  it('стрелки и Home/End двигают выбор по всей ленте', () => {
    stubApi();
    renderEditor(
      makeSnapshot([makePass({ pages: pages(2) }), makePass({ number: 2, pages: pages(2, 3) })]),
    );

    const rail = screen.getByLabelText('Отсканированные страницы');
    fireEvent.keyDown(rail, { key: 'ArrowRight' });
    expect(screen.getByText('2 из 4')).toBeDefined();
    fireEvent.keyDown(rail, { key: 'ArrowRight' });
    // Переход через границу прохода.
    expect(screen.getByText('3 из 4')).toBeDefined();
    fireEvent.keyDown(rail, { key: 'Home' });
    expect(screen.getByText('1 из 4')).toBeDefined();
    fireEvent.keyDown(rail, { key: 'End' });
    expect(screen.getByText('4 из 4')).toBeDefined();
  });

  it('кнопки статус-бара листают страницы и упираются в края', () => {
    stubApi();
    renderEditor(makeSnapshot([makePass({ pages: pages(2) })]));

    const prev = screen.getByRole('button', { name: 'Предыдущая страница' });
    const next = screen.getByRole('button', { name: 'Следующая страница' });
    expect(prev.hasAttribute('disabled')).toBe(true);

    fireEvent.click(next);
    expect(screen.getByText('2 из 2')).toBeDefined();
    expect(next.hasAttribute('disabled')).toBe(true);
    expect(prev.hasAttribute('disabled')).toBe(false);
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
    expect(screen.getByText('17 стр. · прерван')).toBeDefined();
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
    expect(screen.getByText('5 стр. · принят как есть')).toBeDefined();
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
    expect(screen.getByText(/Файл этой страницы потерян/)).toBeDefined();
  });

  it('«Новое сканирование» открывает модалку; отмена ничего не шлёт', () => {
    const api = stubApi();
    renderEditor(makeSnapshot([makePass({ pages: pages(24) })]));

    fireEvent.click(screen.getByRole('button', { name: /Новое сканирование/ }));
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByText(/24 отсканированные страницы будут удалены/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.closeSession).not.toHaveBeenCalled();
  });

  it('скрытых элементов макета нет в разметке', () => {
    stubApi();
    renderEditor(makeSnapshot([makePass({})]));

    expect(screen.queryByText(/Сохранить/)).toBeNull();
    expect(screen.queryByText(/Добавить/)).toBeNull();
    expect(screen.queryByText('↻')).toBeNull();
    expect(screen.queryByTitle(/Повернуть/)).toBeNull();
    expect(screen.queryByText(/Удалить страницу/)).toBeNull();
    expect(screen.queryByText(/Пересканировать/)).toBeNull();
    expect(screen.queryByText(/пустые/)).toBeNull();
  });
});
