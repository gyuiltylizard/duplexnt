import {
  EMPTY_EDITS,
  ok,
  type BlankMode,
  type BlankVerdicts,
  type ScannerState,
  type SessionSnapshot,
  type Snapshot,
} from '@shared';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { assemblyWithEditsOf } from '../state/assembly-fixture';
import {
  applied,
  B1,
  B2,
  B3,
  ctrlZ,
  dragAndDrop,
  F1,
  F2,
  F3,
  lastSent,
  makePass,
  makeSnapshot,
  nextSnapshot,
  option,
  pages,
  renderEditor,
  selectedKeys,
  settle,
  stubApi,
} from './editor-fixture';

// Экран `editor`, M4 (план U6; handoff M4, S1–S13): показанная лента без скрытых пустых
// оборотов, переключатель «добавить пустые», скрытые хвосты при переносе и удалении, метка
// «ПУСТО», пометка «Это не пустая страница», пункт ПРОВЕРКИ, поздние оценки, все скрыты.
// Флаги считает зеркало сборки по вердиктам (guard-тест сверяет его с ядром).

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Лента AE1: F1, B3, F2, B2, F3, B1. Пустые обороты — B3 (хвост F1) и B1 (хвост F3).
const VERDICTS: BlankVerdicts = new Map([
  [B1, true],
  [B2, false],
  [B3, true],
]);

function blankSnapshot(mode: BlankMode = 'hide', blank: BlankVerdicts = VERDICTS) {
  return makeSnapshot(
    [
      makePass({ pages: pages(3) }),
      makePass({ number: 2, kind: 'backs', pages: pages(3, 1, 'p02-s01') }),
    ],
    {},
    { blankMode: mode },
    blank,
  );
}

const READY: ScannerState = {
  kind: 'ready',
  scanner: { name: 'ScanPro 200', scheme: 'https', host: '192.0.2.10', port: 443 },
  options: { colorModes: ['Grayscale8'], resolutions: [300], paperSizes: ['A4'] },
  params: { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' },
};

/** Сессия снимка — в фикстурах она есть всегда. */
const sessionOf = (snapshot: Snapshot): SessionSnapshot => {
  if (snapshot.session === null) {
    throw new Error('в фикстуре нет сессии');
  }
  return snapshot.session;
};

const keysShown = (): (string | null)[] =>
  screen.getAllByRole('option').map((element) => element.getAttribute('data-key'));

const revealToggle = (): HTMLInputElement =>
  screen.getByRole<HTMLInputElement>('checkbox', {
    name: 'Показать скрытые пустые обороты в ленте — в файл они не попадут',
  });

const current = (): HTMLElement => {
  const element = document.querySelector<HTMLElement>('[role="option"][tabindex="0"]');
  if (element === null) {
    throw new Error('нет текущей миниатюры');
  }
  return element;
};

describe('пустые обороты в редакторе (M4)', () => {
  it('S1: без переключателя скрытых нет — нумерация, счётчик и «стр. N из M» по показанной ленте', () => {
    stubApi();
    renderEditor(blankSnapshot());

    expect(keysShown()).toEqual([F1, F2, B2, F3]);
    expect(screen.getByText('стр. 1 из 4')).toBeDefined();
    expect(screen.getByText('1 из 4')).toBeDefined();
    expect(option(3).textContent).toContain('4');
    // Счётчик переключателя — скрытые.
    expect(screen.getByText('скрыто: 2')).toBeDefined();
    expect(screen.getByText('4 стр.')).toBeDefined();
  });

  it('S5/S3: переключатель показывает скрытые с меткой и пунктиром, нумерация пересчитывается', () => {
    stubApi();
    renderEditor(blankSnapshot());

    fireEvent.click(revealToggle());
    expect(keysShown()).toEqual([F1, B3, F2, B2, F3, B1]);
    expect(screen.getByText('стр. 1 из 6')).toBeDefined();
    expect(screen.getByText('показано: 2')).toBeDefined();
    const hidden = option(1);
    expect(hidden.className).toContain('thumb--hidden');
    expect(hidden.textContent).toContain('ПУСТО');
    expect(hidden.getAttribute('aria-label')).toBe(
      'Страница 2, пустая, скрыта — в файл не попадёт',
    );
    // Выключение — скрытые уходят, текущая остаётся.
    fireEvent.click(revealToggle());
    expect(keysShown()).toEqual([F1, F2, B2, F3]);
    expect(selectedKeys()).toEqual([F1]);
  });

  it('S5: без найденных переключатель недоступен — «не найдено» или «оцениваются…»', () => {
    stubApi();
    const none = new Map([
      [B1, false],
      [B2, false],
      [B3, false],
    ]);
    const { rerender } = renderEditor(blankSnapshot('hide', none));
    expect(revealToggle().disabled).toBe(true);
    expect(screen.getByText('не найдено')).toBeDefined();

    rerender(blankSnapshot('hide', new Map([[B2, false]])));
    expect(revealToggle().disabled).toBe(true);
    expect(screen.getByText('оцениваются…')).toBeDefined();
  });

  it('S5: при «Помечать» и «Оставлять» переключателя нет; при «Помечать» все страницы с метками', () => {
    stubApi();
    const { rerender } = renderEditor(blankSnapshot('mark'));
    expect(screen.queryByRole('checkbox', { name: /Показать скрытые/u })).toBeNull();
    expect(keysShown().length).toBe(6);
    expect(option(1).textContent).toContain('ПУСТО');
    expect(option(1).className).not.toContain('thumb--hidden');
    expect(option(1).getAttribute('aria-label')).toBe('Страница 2, пустая');
    expect(option(0).textContent).not.toContain('ПУСТО');

    rerender(blankSnapshot('keep'));
    expect(screen.queryByRole('checkbox', { name: /Показать скрытые/u })).toBeNull();
    expect(screen.queryByText('ПУСТО')).toBeNull();
  });

  it('клавиатура: → и End идут по показанной ленте; Shift-диапазон не захватывает скрытые', () => {
    stubApi();
    renderEditor(blankSnapshot());

    fireEvent.keyDown(current(), { key: 'ArrowRight' });
    expect(selectedKeys()).toEqual([F2]);
    fireEvent.keyDown(current(), { key: 'End' });
    expect(selectedKeys()).toEqual([F3]);
    fireEvent.keyDown(current(), { key: 'Home' });
    fireEvent.keyDown(current(), { key: 'ArrowRight', shiftKey: true });
    expect(selectedKeys()).toEqual([F1, F2]);
    expect(screen.getByText('Выделено 2 стр. · Shift — диапазон, Ctrl — по одной')).toBeDefined();
  });

  it('R12: удаление лица уносит скрытый хвост одним шагом; тост — по показанным; Ctrl+Z возвращает обоих', async () => {
    const api = stubApi();
    const snapshot = blankSnapshot();
    const { onToast, rerender } = renderEditor(snapshot);

    fireEvent.keyDown(current(), { key: 'Delete' });
    expect(lastSent(api).edits.deleted).toEqual([F1, B3]);
    await settle();
    expect(onToast).toHaveBeenCalledWith('Страница удалена — Ctrl+Z вернёт');
    const after = applied(snapshot, lastSent(api), VERDICTS);
    rerender(after);
    expect(keysShown()).toEqual([F2, B2, F3]);
    expect(selectedKeys()).toEqual([F2]);

    ctrlZ();
    expect(lastSent(api).edits).toEqual(EMPTY_EDITS);
    await settle();
    onToast.mockClear();
    rerender(applied(after, lastSent(api), VERDICTS));
    expect(keysShown()).toEqual([F1, F2, B2, F3]);
    // Хвост вернулся в скрытые правкой, не вердиктом — тоста поздней оценки нет (ревью).
    expect(onToast).not.toHaveBeenCalled();
  });

  it('R12/AE9: перенос листа 3 после листа 1 с хвостом даёт 1л, 1о, 3л, 3о', () => {
    const api = stubApi();
    renderEditor(blankSnapshot());

    dragAndDrop(option(3), option(0), 'after');
    expect(lastSent(api).edits.order).toEqual([F1, B3, F3, B1, F2, B2]);
  });

  it('R12: при включённом переключателе перенос буквальный — хвост не едет', () => {
    const api = stubApi();
    renderEditor(blankSnapshot());
    fireEvent.click(revealToggle());

    // Полная лента: F1, B3, F2, B2, F3, B1; F3 — пятая.
    dragAndDrop(option(4), option(0), 'after');
    expect(lastSent(api).edits.order).toEqual([F1, F3, B3, F2, B2, B1]);
  });

  it('R12: при включённом переключателе удаление буквальное — лицо без хвоста', () => {
    const api = stubApi();
    renderEditor(blankSnapshot());
    fireEvent.click(revealToggle());

    fireEvent.keyDown(current(), { key: 'Delete' });
    expect(lastSent(api).edits.deleted).toEqual([F1]);
  });

  it('R12: разрез ложится перед показанной страницей — хвост предыдущей остаётся слева', () => {
    const api = stubApi();
    renderEditor(blankSnapshot());

    fireEvent.click(option(1)); // F2
    fireEvent.click(screen.getByRole('button', { name: '+ Новый документ с этой страницы' }));
    // Позиция F2 в полной ленте — 2 (после F1 и его хвоста B3).
    expect(lastSent(api).edits.cuts).toEqual([2]);
  });

  it('R11: текущая, ставшая скрытой, переезжает на ближайшую показанную справа', () => {
    stubApi();
    renderEditor(blankSnapshot());
    fireEvent.click(revealToggle());
    fireEvent.click(option(1)); // B3 — скрытая, показана
    expect(screen.getByText('2 из 6')).toBeDefined();

    fireEvent.click(revealToggle());
    expect(selectedKeys()).toEqual([F2]);
    expect(screen.getByText('2 из 4')).toBeDefined();
  });

  it('S8/S9/S10: превью, секция «ПУСТОЙ ОБОРОТ» и факт «Содержимое» у пустой страницы', () => {
    stubApi();
    const { rerender } = renderEditor(blankSnapshot('mark'));
    fireEvent.click(option(1));

    expect(screen.getByText('ПУСТАЯ СТОРОНА')).toBeDefined();
    const inspector = screen.getByRole('complementary', { name: 'Сведения о наборе' });
    expect(
      within(inspector).getByText(
        'Распознано автоматически: на странице нет чернил. Она останется в файле с меткой.',
      ),
    ).toBeDefined();
    fireEvent.click(within(inspector).getByRole('button', { name: /ДЕТАЛИ/u }));
    expect(within(inspector).getByText('пустая — с меткой')).toBeDefined();

    rerender(blankSnapshot('hide'));
    fireEvent.click(revealToggle());
    fireEvent.click(option(1));
    expect(screen.getByText('ПУСТАЯ СТОРОНА · НЕ ПОПАДЁТ В ФАЙЛ')).toBeDefined();
    expect(
      within(inspector).getByText(
        'Распознано автоматически: на странице нет чернил. Она скрыта и в файл не попадёт.',
      ),
    ).toBeDefined();
    expect(within(inspector).getByText('пустая — скрыта')).toBeDefined();
    // У обычной страницы ни секции, ни факта.
    fireEvent.click(option(0));
    expect(within(inspector).queryByText('ПУСТОЙ ОБОРОТ')).toBeNull();
    expect(within(inspector).queryByText('Содержимое')).toBeNull();
  });

  it('S9: «Это не пустая страница» — один setEdits с notBlank, плашка, тост; Ctrl+Z прячет снова и переезжает', async () => {
    const api = stubApi();
    const snapshot = blankSnapshot();
    const { onToast, rerender } = renderEditor(snapshot);
    fireEvent.click(revealToggle());
    fireEvent.click(option(1)); // B3

    fireEvent.click(screen.getByRole('button', { name: 'Это не пустая страница' }));
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: { ...EMPTY_EDITS, notBlank: [B3] },
      rotate180: {},
    });
    await settle();
    expect(onToast).toHaveBeenCalledWith('Страница возвращена в документ — Ctrl+Z отменит');
    const marked = applied(snapshot, lastSent(api), VERDICTS);
    rerender(marked);
    expect(screen.getByText('Есть ручные правки')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Это не пустая страница' })).toBeNull();
    expect(option(1).textContent).not.toContain('ПУСТО');
    const inspector = screen.getByRole('complementary', { name: 'Сведения о наборе' });
    fireEvent.click(within(inspector).getByRole('button', { name: /ДЕТАЛИ/u }));
    expect(within(inspector).getByText('не пустая — ваша пометка')).toBeDefined();
    expect(screen.getByText('показано: 1')).toBeDefined();

    // Переключатель выключен — B3 остаётся: она больше не пустая.
    fireEvent.click(revealToggle());
    expect(keysShown()).toEqual([F1, B3, F2, B2, F3]);

    ctrlZ();
    expect(lastSent(api).edits).toEqual(EMPTY_EDITS);
    await settle();
    onToast.mockClear();
    rerender(applied(marked, lastSent(api), VERDICTS));
    expect(keysShown()).toEqual([F1, F2, B2, F3]);
    expect(selectedKeys()).toEqual([F2]);
    // Скрытие правкой, не вердиктом — тоста поздних оценок нет.
    expect(onToast).not.toHaveBeenCalled();
  });

  it.each([
    ['hide', VERDICTS, 'Скрыто 2 пустых оборота — в файл не попадут', true],
    ['mark', VERDICTS, 'Помечено 2 пустых оборота — останутся в файле', false],
    [
      'hide',
      new Map([
        [B1, false],
        [B2, false],
        [B3, false],
      ]),
      'Пустых оборотов не найдено',
      false,
    ],
    ['hide', new Map([[B1, true]]), 'Оценка пустых оборотов: ещё 2 стр.', true],
  ] as const)('S11: ПРОВЕРКА при «%s»: «%s»', (mode, blank, text, warning) => {
    stubApi();
    renderEditor(blankSnapshot(mode, blank));

    const item = screen.getByText(text).closest('li');
    expect(item?.className.includes('check--warning')).toBe(warning);
  });

  it('S11: при «Оставлять» пункта нет; в режиме наборов при «Скрывать» — «считаются в наборах»', () => {
    stubApi();
    const { rerender } = renderEditor(blankSnapshot('keep'));
    expect(screen.queryByText(/пустых оборотов/iu)).toBeNull();

    rerender(
      makeSnapshot(
        [
          makePass({ pages: pages(3) }),
          makePass({ number: 2, kind: 'backs', pages: pages(2, 1, 'p02-s01') }),
        ],
        {},
        { blankMode: 'hide' },
        new Map([
          [B1, true],
          [B2, false],
        ]),
      ),
    );
    expect(
      screen.getByText('Помечен 1 пустой оборот — считается в наборах, скроется после сборки'),
    ).toBeDefined();
    expect(screen.queryByRole('checkbox', { name: /Показать скрытые/u })).toBeNull();
    expect(keysShown().length).toBe(5);
  });

  it('S13: поздняя оценка прячет страницу с тостом один раз, текущая переезжает, стек undo цел', async () => {
    const api = stubApi();
    const early = new Map([
      [B1, true],
      [B2, false],
    ]);
    const snapshot = blankSnapshot('hide', early);
    const { onToast, rerender } = renderEditor(snapshot);
    expect(keysShown()).toEqual([F1, B3, F2, B2, F3]);
    fireEvent.click(option(1)); // B3 — ещё без оценки

    // Правка до оценки — чтобы было что откатывать.
    fireEvent.click(screen.getByRole('button', { name: 'Повернуть на 90° по часовой' }));
    await settle();
    const rotated = applied(snapshot, lastSent(api), early);
    rerender(rotated);
    onToast.mockClear();

    // Фокус — на карточке B3: после скрытия она размонтируется.
    option(1).focus();
    const late = nextSnapshot(rotated, {
      assembly: () => assemblyWithEditsOf(sessionOf(rotated), VERDICTS),
    });
    rerender(late);
    expect(keysShown()).toEqual([F1, F2, B2, F3]);
    expect(selectedKeys()).toEqual([F2]);
    // Фокус переехал вместе с текущей, а не упал на body (ревью).
    expect(document.activeElement).toBe(option(1));
    expect(onToast).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenCalledWith(
      'Скрыт 1 пустой оборот — переключатель «добавить пустые» покажет его',
    );
    // Тот же снимок ещё раз — тоста нет.
    rerender({ ...late, seq: late.seq + 1 });
    expect(onToast).toHaveBeenCalledTimes(1);
    // Ctrl+Z всё ещё откатывает поворот.
    ctrlZ();
    expect(lastSent(api).edits).toEqual(EMPTY_EDITS);
  });

  it.each([
    ['снимок раньше ответа', 'snapshot-first'],
    ['ответ раньше снимка', 'reply-first'],
  ] as const)(
    'S13: «Собрать документ» со скрытыми — один тост с числом скрытых, %s',
    async (_name, order) => {
      let resolve: (value: Awaited<ReturnType<typeof window.api.assemble>>) => void = () =>
        undefined;
      const assemble = vi.fn(
        () =>
          new Promise<Awaited<ReturnType<typeof window.api.assemble>>>((done) => {
            resolve = done;
          }),
      );
      stubApi({ assemble });
      // Наборы уравнены добавленным листом: лица 3, обороты 2 + один добавленный; B1 — пустой.
      const passes = [
        makePass({ pages: pages(3) }),
        makePass({ number: 2, kind: 'backs', pages: pages(2, 1, 'p02-s01') }),
        makePass({ number: 3, kind: 'added', after: B1, pages: pages(1, 1, 'p03-s01') }),
      ];
      const sets = makeSnapshot(passes, {}, { blankMode: 'hide' }, VERDICTS);
      const { onToast, rerender } = renderEditor(sets);
      expect(sessionOf(sets).passes.length).toBe(3);
      expect(sets.assembly?.report.mode).toBe('sets');
      expect(sets.assembly?.blank).toMatchObject({ hidden: 0 });

      fireEvent.click(screen.getByRole('button', { name: 'Собрать документ' }));
      const assembled = makeSnapshot(
        passes,
        {},
        { blankMode: 'hide', assembled: [F1, B2, F2, B1, F3, 'p03-s01-0001'] },
        VERDICTS,
      );
      expect(assembled.assembly?.blank).toMatchObject({ mode: 'hide', hidden: 1 });
      const reply = async (): Promise<void> => {
        await act(async () => {
          resolve(ok(undefined));
          await Promise.resolve();
        });
      };
      if (order === 'snapshot-first') {
        rerender(assembled);
        expect(onToast).not.toHaveBeenCalled();
        await reply();
      } else {
        await reply();
        expect(onToast).not.toHaveBeenCalled();
        rerender(assembled);
      }
      expect(onToast).toHaveBeenCalledTimes(1);
      expect(onToast).toHaveBeenCalledWith('Документ собран: 3 листа — скрыт 1 пустой оборот');
      // Повторный снимок того же состояния тоста не плодит.
      rerender({ ...assembled, seq: assembled.seq + 1 });
      expect(onToast).toHaveBeenCalledTimes(1);
    },
  );

  it('S13: при включённом переключателе поздняя оценка ничего не прячет — тоста нет', () => {
    stubApi();
    const early = new Map([
      [B1, true],
      [B2, false],
    ]);
    const snapshot = blankSnapshot('hide', early);
    const { onToast, rerender } = renderEditor(snapshot);
    fireEvent.click(revealToggle());

    rerender(
      nextSnapshot(snapshot, {
        assembly: () => assemblyWithEditsOf(sessionOf(snapshot), VERDICTS),
      }),
    );
    expect(keysShown().length).toBe(6);
    expect(onToast).not.toHaveBeenCalled();
  });

  it('S7: все показанные страницы скрыты — подсказка, лента «Все страницы скрыты», фокус на переключателе', () => {
    stubApi();
    const base = makeSnapshot(
      [
        makePass({ pages: pages(1) }),
        makePass({ number: 2, kind: 'backs', pages: pages(1, 1, 'p02-s01') }),
      ],
      {},
      { blankMode: 'hide', edits: { ...EMPTY_EDITS, deleted: [F1] } },
    );
    renderEditor({
      ...base,
      assembly: assemblyWithEditsOf(sessionOf(base), new Map([[B1, true]])),
    });

    expect(screen.queryAllByRole('option')).toEqual([]);
    expect(screen.getByText('Все страницы — пустые обороты')).toBeDefined();
    expect(screen.getByText('Все страницы скрыты')).toBeDefined();
    expect(screen.getByText('—')).toBeDefined();
    expect(document.activeElement).toBe(revealToggle());

    fireEvent.click(revealToggle());
    expect(keysShown()).toEqual([B1]);
    expect(selectedKeys()).toEqual([B1]);
  });

  it('S14: модалка save считает страницы файла — без скрытых и при включённом переключателе', () => {
    stubApi();
    renderEditor(blankSnapshot());
    fireEvent.click(revealToggle());
    expect(screen.getByText('стр. 1 из 6')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить документ' }));
    const dialog = screen.getByRole('dialog', { name: 'Сохранить документ' });
    expect(within(dialog).getByText('Страниц всего').nextElementSibling?.textContent).toBe('4');
    expect(within(dialog).getByText('Пустых оборотов').nextElementSibling?.textContent).toBe(
      'скрыто 2 — не попадут в файл',
    );
    expect(within(dialog).getByText('4 стр.')).toBeDefined();
  });

  it('S15: модалка newscan — «N стр.» по файлу и отдельное предложение про скрытые', () => {
    stubApi();
    renderEditor(blankSnapshot());

    fireEvent.click(screen.getByRole('button', { name: /Новое сканирование/u }));
    expect(document.getElementById('newscan-text')?.textContent).toBe(
      'Последние изменения не сохранены в файл. Если начать новое сканирование, 4 стр. будут удалены с диска. Скрытые пустые обороты (2 стр.) тоже будут стёрты.',
    );
  });

  it('S16: «После текущей страницы» в add — после скрытого хвоста, номера по показанной ленте', () => {
    stubApi();
    const onAdd = vi.fn();
    renderEditor({ ...blankSnapshot(), scanner: READY }, { onAdd });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    fireEvent.click(screen.getByRole('radio', { name: /После текущей страницы/u }));
    expect(screen.getByText(/после стр\. 1 \(лицо листа 1\)/u)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Начать скан' }));
    expect(onAdd).toHaveBeenCalledWith('addedFronts', B3);
  });

  it('S16: номер «после стр. N» — по показанной ленте и при скрытых перед текущей (упрощение M4)', () => {
    stubApi();
    const onAdd = vi.fn();
    renderEditor({ ...blankSnapshot(), scanner: READY }, { onAdd });
    // Показанная лента F1, F2, B2, F3: F3 — четвёртая (в полной — пятая).
    fireEvent.click(option(3));
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    fireEvent.click(screen.getByRole('radio', { name: /После текущей страницы/u }));
    expect(screen.getByText(/после стр\. 4 \(лицо листа 3\)/u)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Начать скан' }));
    expect(onAdd).toHaveBeenCalledWith('addedFronts', B1);
  });
});
