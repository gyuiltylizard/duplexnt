import {
  EMPTY_EDITS,
  pageImageUrl,
  type BlankVerdicts,
  type SessionSnapshot,
  type SkewOutcome,
  type Snapshot,
  type StraightenFact,
  type StraightenFacts,
} from '@shared';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { assemblyOf, assemblyWithEditsOf } from '../state/assembly-fixture';
import {
  applied,
  B3,
  ctrlZ,
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

// Экран `editor`, M6 (план U8; handoff M6): пометки и вид по статусу на карточке и в превью,
// секция ВЫРАВНИВАНИЕ с «Оставить оригинал» / «Выровнять» (на текущую и на выделение, AE17),
// факт в ДЕТАЛЯХ, пункт ПРОВЕРКИ, тосты действия и поздних статусов, модалка `save` с
// `straightenPending`. Статусы считает зеркало сборки по фактам (guard-тест сверяет его с ядром).

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SESSION = 'session.x';
const P = (n: number): string => `p01-s01-000${String(n)}`;

const fact = (
  outcome: SkewOutcome | null,
  extra: Partial<StraightenFact> = {},
): StraightenFact => ({
  outcome,
  version: null,
  deferred: null,
  ...extra,
});

// Шесть лиц: 1 — выровнена, 2 — ровная, 3 — не по чему мерить, 4 — отложена (место),
// 5 — в обработке, 6 — выровнена.
const FACTS: StraightenFacts = new Map([
  [P(1), fact('willStraighten', { version: 1 })],
  [P(2), fact('level')],
  [P(3), fact('unmeasurable')],
  [P(4), fact('willStraighten', { deferred: 'noSpace' })],
  [P(5), fact(null)],
  [P(6), fact('willStraighten', { version: 1 })],
]);

/** Те же страницы после обработки: пятая выровнена. */
const DONE: StraightenFacts = new Map([...FACTS, [P(5), fact('willStraighten', { version: 1 })]]);

function straightSnapshot(facts: StraightenFacts = FACTS, mode: 'auto' | 'off' = 'auto') {
  return makeSnapshot([makePass({ pages: pages(6) })], {}, { straighten: mode }, undefined, facts);
}

const sessionOf = (snapshot: Snapshot): SessionSnapshot => {
  if (snapshot.session === null) {
    throw new Error('в фикстуре нет сессии');
  }
  return snapshot.session;
};

const inspector = (): HTMLElement =>
  screen.getByRole('complementary', { name: 'Сведения о наборе' });
const thumbSrc = (index: number): string | null | undefined =>
  option(index).querySelector('img')?.getAttribute('src');
const previewSrc = (): string | null | undefined =>
  document.querySelector('.preview__img')?.getAttribute('src');
const straightButton = (name: string | RegExp): HTMLElement =>
  within(inspector()).getByRole('button', { name });
const checkTexts = (): string[] =>
  [...inspector().querySelectorAll('.check')].map((item) => item.textContent);

describe('выравнивание в редакторе (M6)', () => {
  it('карточки: глиф и адрес выправленного вида у выровненной, «не выровнено» с причиной, точки у ждущей, ничего у ровной', () => {
    stubApi();
    renderEditor(straightSnapshot());

    expect(option(0).getAttribute('aria-label')).toBe('Страница 1, выровнена');
    expect(option(0).querySelector('.thumb__straight--done')?.getAttribute('title')).toBe(
      'Выровнено — исходный скан цел',
    );
    expect(thumbSrc(0)).toBe(pageImageUrl(SESSION, 'straight-thumb', P(1), 1));

    expect(option(1).getAttribute('aria-label')).toBe('Страница 2');
    expect(option(1).querySelector('.thumb__straight, .thumb__pending')).toBeNull();
    expect(thumbSrc(1)).toBe(pageImageUrl(SESSION, 'thumb', P(2)));

    expect(option(2).getAttribute('aria-label')).toBe(
      'Страница 3, не выровнена: не по чему мерить',
    );
    expect(option(2).querySelector('.thumb__straight--undone')?.getAttribute('title')).toBe(
      'Не выровнено: не по чему мерить',
    );
    expect(thumbSrc(2)).toBe(pageImageUrl(SESSION, 'thumb', P(3)));

    expect(option(3).getAttribute('aria-label')).toBe(
      'Страница 4, не выровнена: мало места на диске',
    );
    expect(option(3).querySelector('.thumb__straight--undone')?.getAttribute('title')).toBe(
      'Не выровнено: мало места на диске — приложение попробует снова при следующем запуске',
    );

    expect(option(4).getAttribute('aria-label')).toBe('Страница 5, выравнивается');
    expect(option(4).querySelector('.thumb__pending')?.getAttribute('title')).toBe(
      'Выравнивается — сохранение подождёт',
    );
    expect(option(4).querySelectorAll('.thumb__pending i')).toHaveLength(3);
    // Подвал на месте: слот вне потока, номер и теги не сдвигаются.
    expect(option(4).querySelector('.thumb__foot')?.textContent).toBe('5');
  });

  it('превью: пилюля и вид по статусу текущей; откат — исходник без пилюли', async () => {
    const api = stubApi();
    const snapshot = straightSnapshot();
    const { rerender } = renderEditor(snapshot);

    expect(screen.getByText('ВЫРОВНЕНО')).toBeDefined();
    expect(previewSrc()).toBe(pageImageUrl(SESSION, 'straight', P(1), 1));

    fireEvent.click(option(2));
    expect(screen.getByText('НЕ ВЫРОВНЕНО').getAttribute('title')).toBe(
      'Не выровнено: не по чему мерить',
    );
    expect(previewSrc()).toBe(pageImageUrl(SESSION, 'page', P(3)));

    fireEvent.click(option(4));
    expect(screen.getByText('ВЫРАВНИВАЕТСЯ')).toBeDefined();
    expect(document.querySelectorAll('.preview__straight-dots i')).toHaveLength(3);

    fireEvent.click(option(1));
    expect(document.querySelector('.preview__straight')).toBeNull();

    // Откат первой: адрес превью и миниатюры меняются на месте — та же карточка, без плашки.
    fireEvent.click(option(0));
    const card = option(0);
    fireEvent.click(straightButton('Оставить оригинал'));
    await settle();
    rerender(applied(snapshot, lastSent(api), undefined, FACTS));
    expect(option(0)).toBe(card);
    expect(previewSrc()).toBe(pageImageUrl(SESSION, 'page', P(1)));
    expect(thumbSrc(0)).toBe(pageImageUrl(SESSION, 'thumb', P(1)));
    expect(document.querySelector('.preview__straight')).toBeNull();
  });

  it('инспектор, одна страница: «Оставить оригинал» — один setEdits с keepOriginal, без тоста; статус kept, факт, плашка, фокус на «Выровнять»; Ctrl+Z возвращает без тоста', async () => {
    const api = stubApi();
    const snapshot = straightSnapshot();
    const { onToast, rerender } = renderEditor(snapshot);

    expect(
      within(inspector()).getByText(
        'Строки на странице шли веером — приложение выровняло их. Исходный скан цел.',
      ),
    ).toBeDefined();
    const keep = straightButton('Оставить оригинал');
    expect(keep.getAttribute('title')).toBe(
      'Показать и сохранить как со сканера. Это правка: Ctrl+Z или «Вернуть» её снимут.',
    );
    keep.focus();
    fireEvent.click(keep);
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: { ...EMPTY_EDITS, keepOriginal: [P(1)] },
      rotate180: {},
    });
    await settle();
    expect(onToast).not.toHaveBeenCalled();

    const kept = applied(snapshot, lastSent(api), undefined, FACTS);
    rerender(kept);
    expect(screen.getByText('Есть ручные правки')).toBeDefined();
    expect(option(0).getAttribute('aria-label')).toBe('Страница 1');
    expect(option(0).querySelector('.thumb__straight')).toBeNull();
    expect(
      within(inspector()).getByText(
        'Страница оставлена как со сканера — по вашему выбору. Выровненный вид не потерян: его можно вернуть.',
      ),
    ).toBeDefined();
    const restore = straightButton('Выровнять');
    expect(restore.getAttribute('title')).toBe('Вернуть выровненный вид. Ctrl+Z отменит.');
    // Фокус остался на кнопке, ставшей парной (handoff M6, Behaviour).
    expect(document.activeElement).toBe(restore);
    expect(selectedKeys()).toEqual([P(1)]);
    fireEvent.click(within(inspector()).getByRole('button', { name: /ДЕТАЛИ/u }));
    expect(within(inspector()).getByText('оригинал — ваш выбор')).toBeDefined();

    ctrlZ();
    expect(lastSent(api).edits).toEqual(EMPTY_EDITS);
    await settle();
    const restored = applied(kept, lastSent(api), undefined, FACTS);
    rerender(restored);
    expect(option(0).getAttribute('aria-label')).toBe('Страница 1, выровнена');
    expect(within(inspector()).getByText('выровнена')).toBeDefined();
    // Правка, не поздний статус: тоста нет.
    expect(onToast).not.toHaveBeenCalled();

    // «Выровнять» снимает ключ.
    fireEvent.click(straightButton('Оставить оригинал'));
    await settle();
    rerender(applied(restored, lastSent(api), undefined, FACTS));
    fireEvent.click(straightButton('Выровнять'));
    expect(lastSent(api).edits).toEqual(EMPTY_EDITS);
  });

  it('AE17, выделение из нескольких: сводка, кнопки с числом, действие только на подходящие, тост; затем «Выровнять» только у откаченных', async () => {
    const api = stubApi();
    const snapshot = straightSnapshot();
    const { onToast, rerender } = renderEditor(snapshot);
    fireEvent.click(option(0));
    fireEvent.click(option(5), { shiftKey: true });

    expect(
      within(inspector()).getByText(
        'Из 6 выделенных: выровнено 2, не выровнено 2, в обработке 1, ровных 1.',
      ),
    ).toBeDefined();
    expect(within(inspector()).queryByRole('button', { name: /^Выровнять/u })).toBeNull();
    fireEvent.click(straightButton('Оставить оригинал — 2 из 6 выделенных'));
    expect(lastSent(api).edits).toEqual({ ...EMPTY_EDITS, keepOriginal: [P(1), P(6)] });
    await settle();
    expect(onToast).toHaveBeenCalledExactlyOnceWith('Оставлены оригиналы: 2 стр. — Ctrl+Z отменит');

    const kept = applied(snapshot, lastSent(api), undefined, FACTS);
    rerender(kept);
    // Выделение не изменилось; подходящих для «Оставить оригинал» больше нет — только «Выровнять».
    expect(selectedKeys()).toHaveLength(6);
    expect(
      within(inspector()).getByText(
        'Из 6 выделенных: оригинал по вашему выбору — 2, не выровнено 2, в обработке 1, ровных 1.',
      ),
    ).toBeDefined();
    expect(within(inspector()).queryByRole('button', { name: /^Оставить оригинал/u })).toBeNull();
    onToast.mockClear();
    fireEvent.click(straightButton('Выровнять — 2 из 6 выделенных'));
    expect(lastSent(api).edits).toEqual(EMPTY_EDITS);
    await settle();
    expect(onToast).toHaveBeenCalledExactlyOnceWith('Выровнено 2 стр. — Ctrl+Z отменит');

    // Подходят все выделенные — подпись без «из».
    rerender(applied(kept, lastSent(api), undefined, FACTS));
    fireEvent.click(option(0));
    fireEvent.click(option(5), { ctrlKey: true });
    expect(straightButton('Оставить оригинал — 2 стр.')).toBeDefined();
  });

  it('AE17: выделение без подходящих — одна недоступная кнопка и причина: «ещё выравниваются» при ждущих, иначе «нет выровненных»', () => {
    stubApi();
    renderEditor(straightSnapshot());
    fireEvent.click(option(1));
    fireEvent.click(option(4), { shiftKey: true });

    const disabled = straightButton('Оставить оригинал');
    expect(disabled.hasAttribute('disabled')).toBe(true);
    expect(disabled.getAttribute('title')).toBe(
      'Выделенные ещё выравниваются — действие станет доступно само.',
    );
    expect(
      within(inspector()).getByText(
        'Выделенные ещё выравниваются — действие станет доступно само.',
      ),
    ).toBeDefined();

    fireEvent.click(option(1));
    fireEvent.click(option(2), { shiftKey: true });
    expect(straightButton('Оставить оригинал').hasAttribute('disabled')).toBe(true);
    expect(
      within(inspector()).getByText(
        'Среди выделенных нет выровненных страниц — оставлять оригинал нечему.',
      ),
    ).toBeDefined();
    expect(
      within(inspector()).getByText('Из 2 выделенных: не выровнено 1, ровных 1.'),
    ).toBeDefined();
  });

  it('ПРОВЕРКА: точка с остатком, пока идёт обработка; затем «Выровнено N» с причинами и подсказкой про место; оставленные оригиналом — хвостом', async () => {
    const api = stubApi();
    const snapshot = straightSnapshot();
    const { rerender } = renderEditor(snapshot);
    expect(checkTexts()).toContain(
      '•Выравнивание: ещё 1 стр.Сохранение подождёт — кнопка станет доступна сама.',
    );

    rerender(
      nextSnapshot(snapshot, { assembly: () => assemblyOf(sessionOf(snapshot), undefined, DONE) }),
    );
    expect(checkTexts()).toContain(
      '✓Выровнено 3 стр.Не выровнено 2: не по чему мерить — 1, мало места на диске — 1. Освободите место на диске — при следующем запуске приложение попробует снова.',
    );

    fireEvent.click(straightButton('Оставить оригинал'));
    await settle();
    rerender(applied(snapshot, lastSent(api), undefined, DONE));
    expect(checkTexts()).toContain(
      '✓Выровнено 2 стр., 1 — оставлена оригиналом' +
        'Не выровнено 2: не по чему мерить — 1, мало места на диске — 1. Освободите место на диске — при следующем запуске приложение попробует снова.',
    );
  });

  it('ПРОВЕРКА: «Все страницы ровные» и «Ни одна страница не выровнена»; при сбое — подсказка про повтор', () => {
    stubApi();
    const level: StraightenFacts = new Map(
      [1, 2, 3, 4, 5, 6].map((n) => [P(n), fact('level')] as const),
    );
    const { rerender } = renderEditor(straightSnapshot(level));
    expect(checkTexts()).toContain('✓Все страницы ровные');

    const failed: StraightenFacts = new Map([
      ...level,
      [P(1), fact('notImproved')],
      [P(2), fact('willStraighten', { deferred: 'failed' })],
    ]);
    rerender(straightSnapshot(failed));
    expect(checkTexts()).toContain(
      '✓Ни одна страница не выровненаНе выровнено 2: коррекция не помогла — 1, сбой коррекции — 1. При следующем запуске приложение попробует снова.',
    );
  });

  it('сессия «Не трогать»: ни пометок, ни пилюли, ни секции, ни факта, ни пункта ПРОВЕРКИ', () => {
    stubApi();
    renderEditor(straightSnapshot(DONE, 'off'));

    expect(
      document.querySelector('.thumb__straight, .thumb__pending, .preview__straight'),
    ).toBeNull();
    expect(thumbSrc(0)).toBe(pageImageUrl(SESSION, 'thumb', P(1)));
    expect(within(inspector()).queryByText('ВЫРАВНИВАНИЕ')).toBeNull();
    fireEvent.click(within(inspector()).getByRole('button', { name: /ДЕТАЛИ/u }));
    expect(within(inspector()).queryByText('Выравнивание')).toBeNull();
    expect(checkTexts().some((text) => text.includes('ыровн'))).toBe(false);
  });

  it('скрытая пустая (статус null): метка пустоты есть, пометки выравнивания нет', () => {
    stubApi();
    const verdicts: BlankVerdicts = new Map([[B3, true]]);
    const facts: StraightenFacts = new Map([[B3, fact('willStraighten', { version: 1 })]]);
    renderEditor(
      makeSnapshot(
        [
          makePass({ pages: pages(3) }),
          makePass({ number: 2, kind: 'backs', pages: pages(3, 1, 'p02-s01') }),
        ],
        {},
        { blankMode: 'mark', straighten: 'auto' },
        verdicts,
        facts,
      ),
    );

    expect(option(1).getAttribute('data-key')).toBe(B3);
    expect(option(1).getAttribute('aria-label')).toBe('Страница 2, пустая');
    expect(option(1).querySelector('.thumb__blank')).not.toBeNull();
    expect(option(1).querySelector('.thumb__straight')).toBeNull();
    expect(thumbSrc(1)).toBe(pageImageUrl(SESSION, 'thumb', B3));
  });

  it('поздние статусы: один тост на порцию, когда ждущих не осталось; тот же снимок ещё раз — без тоста', () => {
    stubApi();
    const snapshot = straightSnapshot();
    const { onToast, rerender } = renderEditor(snapshot);

    // Досканирование: седьмая страница пришла и встала в обработку — порция не закончена.
    const more: StraightenFacts = new Map([...FACTS, [P(7), fact(null)]]);
    const longer = (facts: StraightenFacts, seq: number): Snapshot => ({
      ...makeSnapshot(
        [makePass({ pages: pages(7) })],
        {},
        { straighten: 'auto' },
        undefined,
        facts,
      ),
      seq,
    });
    rerender(longer(more, 2));
    expect(onToast).not.toHaveBeenCalled();

    const done: StraightenFacts = new Map([
      ...DONE,
      [P(7), fact('willStraighten', { version: 1 })],
    ]);
    const landed = longer(done, 3);
    rerender(landed);
    expect(onToast).toHaveBeenCalledExactlyOnceWith('Выровнено ещё 2 стр.');
    rerender({ ...landed, seq: landed.seq + 1 });
    expect(onToast).toHaveBeenCalledTimes(1);
  });

  it('поздние статусы: порция без новых выровненных — тоста нет; пересчёт — «пересчитано», с числом только впервые выровненных', () => {
    stubApi();
    const snapshot = straightSnapshot(DONE);
    const { onToast, rerender } = renderEditor(snapshot);
    const session = sessionOf(snapshot);
    const next = (facts: StraightenFacts): Snapshot =>
      nextSnapshot(snapshot, { assembly: () => assemblyOf(session, undefined, facts) });

    // Досканированная страница померена ровной — выравнивать нечего, тоста нет.
    rerender(next(new Map([...DONE, [P(2), fact(null)]])));
    rerender(next(new Map([...DONE, [P(2), fact('level')]])));
    // Ровная встала в обработку и вернулась ровной — это пересчёт, но хвалиться нечем: 0 новых.
    expect(onToast).toHaveBeenCalledExactlyOnceWith('Выравнивание пересчитано');
    onToast.mockClear();

    // Пересчёт: выровненная ушла в обработку и вернулась выровненной новой версией, а ровная —
    // выровненной впервые.
    rerender(next(new Map([...DONE, [P(1), fact('willStraighten')], [P(2), fact(null)]])));
    expect(onToast).not.toHaveBeenCalled();
    rerender(
      next(
        new Map([
          ...DONE,
          [P(1), fact('willStraighten', { version: 2 })],
          [P(2), fact('willStraighten', { version: 2 })],
        ]),
      ),
    );
    expect(onToast).toHaveBeenCalledExactlyOnceWith(
      'Выравнивание пересчитано — выровнено ещё 1 стр.',
    );
  });

  it('карточка не загрузилась, затем статус сменил вид на месте — новая попытка с новым адресом', () => {
    stubApi();
    const snapshot = straightSnapshot();
    const { rerender } = renderEditor(snapshot);
    const image = option(4).querySelector('img');
    expect(image).not.toBeNull();
    fireEvent.error(image as HTMLElement);
    expect(option(4).querySelector('img')).toBeNull();
    expect(option(4).textContent).toContain('НЕТ МИНИАТЮРЫ');

    const session = sessionOf(snapshot);
    rerender(nextSnapshot(snapshot, { assembly: () => assemblyOf(session, undefined, DONE) }));
    expect(thumbSrc(4)).toBe(pageImageUrl(SESSION, 'straight-thumb', P(5), 1));
  });

  it('модалка save из редактора: пока идёт обработка — статус с остатком и ряд «Выровнено», кнопка недоступна', () => {
    stubApi();
    renderEditor(straightSnapshot());
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить документ' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('status').textContent).toBe(
      'Выравнивание: ещё 1 стр. из 6 — кнопка станет доступна сама.',
    );
    expect(within(dialog).getByText('Выровнено').nextElementSibling?.textContent).toBe(
      '2 стр. · ещё 1 в обработке',
    );
    expect(
      within(dialog).getByRole('button', { name: 'Сохранить файл' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('«Вернуть» снимает и «Оставить оригинал» вместе с остальными правками — подзаголовок говорит об этом', async () => {
    const api = stubApi();
    const snapshot = straightSnapshot();
    const { rerender } = renderEditor(snapshot);
    fireEvent.click(straightButton('Оставить оригинал'));
    await settle();
    rerender(applied(snapshot, lastSent(api), undefined, FACTS));

    fireEvent.click(screen.getByRole('button', { name: 'Вернуть' }));
    expect(screen.getByRole('dialog').textContent).toContain('и выбор «Оставить оригинал»');
    fireEvent.click(screen.getByRole('button', { name: 'Вернуть всё' }));
    expect(lastSent(api).edits).toEqual(EMPTY_EDITS);
    // Снимок с правками строится зеркалом — статусы сходятся с ядром (guard-тест).
    rerender(applied(snapshot, lastSent(api), undefined, FACTS));
    expect(assemblyWithEditsOf(sessionOf(snapshot), undefined, FACTS).straighten.kept).toBe(0);
  });
});
