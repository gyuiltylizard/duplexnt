import { fail, type ScannerState } from '@shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { documentsOf } from '../state/assembly-fixture';
import { EditorScreen } from './EditorScreen';
import {
  deferredSetEdits,
  makePass,
  makeSnapshot,
  option,
  pages,
  renderEditor,
  settle,
  stubApi,
  twoPass,
} from './editor-fixture';

// «+ Добавить» и добавленный набор в редакторе (план M3.5, U6; handoff M3.5, S1, S5–S7):
// гейтинг кнопки с причиной, якорь из видимой ленты (KTD-8), тег набора, ДЕТАЛИ добавленной
// страницы, подсказка в ПРОВЕРКЕ и её снятие (KTD-7).

const READY: ScannerState = {
  kind: 'ready',
  scanner: { name: 'ScanPro 200', scheme: 'https', host: '192.0.2.10', port: 443 },
  options: { colorModes: ['Grayscale8'], resolutions: [300], paperSizes: ['A4'] },
  params: { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' },
};

const addButton = (): HTMLElement => screen.getByRole('button', { name: 'Добавить листы' });
const summary = (): string => document.querySelector('.add-modal__summary')?.textContent ?? '';

/** Пары 3+3 (AE1) — как `twoPass`, но списком проходов для снимка с другими полями. */
const pairs = () => [
  makePass({ pages: pages(3) }),
  makePass({ number: 2, kind: 'backs', pages: pages(3, 1, 'p02-s01') }),
];

/** Пары 3+3 (AE1) плюс добавленный набор из `count` страниц после лица 2. */
function withAdded(count: number, extra: Parameters<typeof makeSnapshot>[2] = {}) {
  return makeSnapshot(
    [
      ...pairs(),
      makePass({
        number: 3,
        kind: 'added',
        after: 'p01-s01-0002',
        pages: pages(count, 1, 'p03-s01'),
      }),
    ],
    {},
    extra,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('«+ Добавить»: доступность (S1, R12)', () => {
  it('в покое доступна и без title; стоит второй в левой зоне тулбара', () => {
    stubApi();
    renderEditor(twoPass());

    const button = addButton();
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.hasAttribute('title')).toBe(false);
    const left = button.parentElement;
    if (left === null) {
      throw new Error('кнопка вне тулбара');
    }
    expect(left.className).toBe('editor-screen__toolbar-left');
    expect(within(left).getAllByRole('button')[1]).toBe(button);
  });

  it('при прерванном последнем проходе недоступна с причиной', () => {
    stubApi();
    renderEditor(
      makeSnapshot([makePass({ state: 'interrupted', pages: pages(3) })], {
        canResume: true,
        canAccept: true,
      }),
    );

    expect(addButton().hasAttribute('disabled')).toBe(true);
    expect(addButton().getAttribute('title')).toBe(
      'Сначала досканируйте прерванный проход или оставьте его как есть',
    );
  });

  it('при правке в полёте недоступна с причиной; после ответа — снова доступна', async () => {
    const { setEdits, answer } = deferredSetEdits();
    stubApi({ setEdits });
    renderEditor(twoPass());

    fireEvent.click(screen.getByRole('button', { name: 'Повернуть на 90° по часовой' }));
    expect(addButton().hasAttribute('disabled')).toBe(true);
    expect(addButton().getAttribute('title')).toBe('Правка ещё записывается — секунду');

    answer(fail('sessionConflict', { reason: 'saving' }));
    await settle();
    expect(addButton().hasAttribute('disabled')).toBe(false);
  });

  it('во время записи пакета недоступна с причиной', async () => {
    stubApi({ saveDocuments: vi.fn(() => new Promise(() => undefined)) });
    renderEditor(twoPass());

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить документ' }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить файл' }));
    await settle();

    expect(addButton().hasAttribute('disabled')).toBe(true);
    expect(addButton().getAttribute('title')).toBe('Документ сохраняется — дождитесь конца записи');
    // S13: обе кнопки поворота тоже недоступны во время записи.
    expect(screen.getByRole('button', { name: /против часовой/ }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('пустая лента: кнопка доступна, в модалке «После текущей» недоступна, якорь — null', () => {
    stubApi();
    const empty = makeSnapshot([makePass({ pages: pages(2) })], { scanner: READY });
    const assembly = empty.assembly;
    if (assembly === null) {
      throw new Error('нет сборки');
    }
    const onAdd = vi.fn();
    renderEditor(
      { ...empty, assembly: { ...assembly, order: [], documents: documentsOf(0), deleted: 2 } },
      { onAdd },
    );

    expect(addButton().hasAttribute('disabled')).toBe(false);
    fireEvent.click(addButton());
    expect(
      screen.getByRole('radio', { name: 'После текущей страницы' }).getAttribute('aria-disabled'),
    ).toBe('true');
    expect(summary()).toBe('Двустороннее · в конец ленты');
    fireEvent.click(screen.getByRole('button', { name: 'Начать скан' }));
    expect(onAdd).toHaveBeenCalledExactlyOnceWith('addedFronts', null);
  });
});

describe('«+ Добавить»: якорь из видимой ленты (S2, KTD-8)', () => {
  it('«После текущей» — ключ текущей; сводка называет её теми же словами, что ДЕТАЛИ', () => {
    stubApi();
    const onAdd = vi.fn();
    renderEditor(makeSnapshot(pairs(), { scanner: READY }), { onAdd });

    // Лента 1л 1о 2л 2о 3л 3о: третья — лицо листа 2.
    fireEvent.click(option(2));
    fireEvent.click(addButton());
    fireEvent.click(screen.getByRole('radio', { name: 'После текущей страницы' }));
    expect(summary()).toBe('Двустороннее · после стр. 3 (лицо листа 2)');
    fireEvent.click(screen.getByRole('button', { name: 'Начать скан' }));
    expect(onAdd).toHaveBeenCalledExactlyOnceWith('addedFronts', 'p01-s01-0002');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('при мультивыделении якорь — страница из превью (текущая)', () => {
    stubApi();
    const onAdd = vi.fn();
    renderEditor(makeSnapshot(pairs(), { scanner: READY }), { onAdd });

    fireEvent.click(option(1));
    fireEvent.click(option(3), { ctrlKey: true });
    fireEvent.click(option(4), { ctrlKey: true });
    // Текущая после Ctrl-кликов — последняя добавленная в выделение: пятая (3л).
    expect(screen.getByText('5 из 6')).toBeDefined();
    fireEvent.click(addButton());
    fireEvent.click(screen.getByRole('radio', { name: 'После текущей страницы' }));
    expect(summary()).toBe('Двустороннее · после стр. 5 (лицо листа 3)');
    fireEvent.click(screen.getByRole('button', { name: 'Начать скан' }));
    expect(onAdd).toHaveBeenCalledExactlyOnceWith('addedFronts', 'p01-s01-0003');
  });

  it('«В конец документа» — последняя видимая страница документа текущей, имя — как в тулбаре', () => {
    stubApi();
    const onAdd = vi.fn();
    const base = makeSnapshot(pairs(), { scanner: READY });
    const assembly = base.assembly;
    if (assembly === null) {
      throw new Error('нет сборки');
    }
    // Два документа: стр. 1–4 «Акт», стр. 5–6 без имени.
    renderEditor(
      { ...base, assembly: { ...assembly, documents: documentsOf(6, [4], ['Акт']) } },
      { onAdd },
    );

    fireEvent.click(option(1));
    fireEvent.click(addButton());
    fireEvent.click(screen.getByRole('radio', { name: 'В конец документа' }));
    expect(summary()).toBe('Двустороннее · в конец документа «Акт», после стр. 4');
    fireEvent.click(screen.getByRole('button', { name: 'Начать скан' }));
    expect(onAdd).toHaveBeenCalledExactlyOnceWith('addedFronts', 'p02-s01-0002');

    // Документ без имени — в сводке имя по умолчанию, как в тулбаре.
    fireEvent.click(option(5));
    fireEvent.click(addButton());
    fireEvent.click(screen.getByRole('radio', { name: 'В конец документа' }));
    expect(summary()).toBe('Двустороннее · в конец документа «Документ 2», после стр. 6');
  });

  it('после «Начать скан» фокус возвращается на «+ Добавить» (и под StrictMode)', () => {
    stubApi();
    const snapshot = makeSnapshot(pairs(), { scanner: READY });
    if (snapshot.session === null) {
      throw new Error('нет сессии');
    }
    const onAdd = vi.fn();
    render(
      <StrictMode>
        <EditorScreen
          snapshot={snapshot}
          session={snapshot.session}
          initialCurrent={null}
          resumeFailure={null}
          onResume={vi.fn()}
          onAdd={onAdd}
          onOpenDevice={vi.fn()}
          onToast={vi.fn()}
        />
      </StrictMode>,
    );

    addButton().focus();
    fireEvent.click(addButton());
    fireEvent.click(screen.getByRole('button', { name: 'Начать скан' }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(addButton());
  });

  it('«Отмена» закрывает модалку без запуска', () => {
    stubApi();
    const onAdd = vi.fn();
    renderEditor(makeSnapshot(pairs(), { scanner: READY }), { onAdd });

    fireEvent.click(addButton());
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onAdd).not.toHaveBeenCalled();
  });
});

describe('добавленный набор в ленте и инспекторе (S5–S7)', () => {
  it('тег «Д1» с aria-label и цветом набора; карточка — «Страница N, добавленный набор K»', () => {
    stubApi();
    renderEditor(withAdded(2));

    // Лента: 1л 1о 2л Д1.1 Д1.2 2о 3л 3о.
    const card = option(3);
    expect(card.getAttribute('aria-label')).toBe('Страница 4, добавленный набор 1');
    const tag = within(card).getByText('Д1');
    expect(tag.classList.contains('thumb__tag--added')).toBe(true);
    expect(tag.getAttribute('aria-label')).toBe('добавленный набор 1');
    expect(within(option(1)).getByText('об').className).toBe('thumb__tag');
    expect(within(option(0)).queryByText(/^Д|^об$/)).toBeNull();
  });

  it('номер набора — от 1 среди добавленных, и при «обороты не нужны» (проходы 1 и 3)', () => {
    stubApi();
    renderEditor(
      makeSnapshot(
        [
          makePass({ pages: pages(2) }),
          makePass({ number: 3, kind: 'added', after: null, pages: pages(1, 1, 'p03-s01') }),
        ],
        {},
        { backsDeclined: true },
      ),
    );

    expect(within(option(2)).getByText('Д1')).toBeDefined();
    expect(screen.queryByText('Д3')).toBeNull();
  });

  it('ДЕТАЛИ добавленной страницы: заголовок, факт «Набор», поворот, пояснение без пары', () => {
    stubApi();
    renderEditor(withAdded(1));

    fireEvent.click(option(3));
    fireEvent.click(screen.getByRole('button', { name: /ДЕТАЛИ/ }));
    expect(screen.getByRole('heading', { name: 'Стр. 4 — добавленный набор 1' })).toBeDefined();
    const facts = screen
      .getAllByRole('term')
      .map((term) => `${term.textContent}: ${term.nextElementSibling?.textContent ?? ''}`);
    expect(facts).toEqual(['Набор: добавленный №1', 'Поворот: 0°']);
    expect(
      screen.getByText(
        'Страница добавленного набора: сканировалась одним проходом, без пары «лицо + оборот».',
      ),
    ).toBeDefined();
  });

  it('M3.6: добавленный набор в группе якоря входит в её счётчик; подсказка ПРОВЕРКИ про перенос', () => {
    stubApi();
    renderEditor(
      makeSnapshot([
        makePass({ pages: pages(3) }),
        makePass({ number: 2, kind: 'backs', pages: pages(2, 1, 'p02-s01') }),
        makePass({
          number: 3,
          kind: 'added',
          after: 'p01-s01-0001',
          pages: pages(1, 1, 'p03-s01'),
        }),
      ]),
    );

    // Набор встал за лицом 1 — в группе лиц: 4 против 2.
    const check = screen
      .getByText('Наборы не уравнены: лицевых 4, оборотных 2 — не хватает 2 оборотов')
      .closest('.check');
    if (!(check instanceof HTMLElement)) {
      throw new Error('пункт наборов вне списка проверок');
    }
    expect(check.className).toBe('check check--warning');
    expect(within(check).getByText(/перенесите страницы через границу/).className).toBe(
      'check__hint',
    );
    expect(screen.getByRole('status', { name: '' }).textContent).toBe(
      'Проходы не сошлись: лицевых 4, оборотных 2',
    );
  });
});
