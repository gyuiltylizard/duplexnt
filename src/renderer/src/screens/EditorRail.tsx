import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_DOCUMENT_NAME_LENGTH, type AssembledPage, type SetsLayout } from '@shared';
import type { DropSide, SetSide } from '../state/edits';
import type { PageOrigin } from '../state/origins';
import { single, type Selection } from '../state/selection';
import type { ShownDocument } from '../state/shown';
import { toneOf } from '../state/page-text';
import {
  EditorThumb,
  pickModifierHeld,
  type PickMode,
  type SplitKind,
  type ThumbDrag,
} from './EditorThumb';

// Лента редактора (план M3, U7–U8; handoff M3, S2–S7; M3.6, S1–S3): группы по документам с
// разделителем «✕» и полем имени, миниатюры с split-баром и перетаскиванием. В режиме
// раздельных наборов (`sets !== null`) вместо групп документов — две группы «Лицевые стороны» и
// «Оборотные стороны» с живыми счётчиками и разделителем-целью дропа; разрезов и имён нет
// (KTD8: `documentsEditable`). Решает только «что и куда» — сами правки строит и шлёт экран
// (жесты `state/edits.ts`, KTD-8). С M4 лента здесь — показанная (без скрытых пустых
// оборотов, handoff M4, S1): позиции — её, документы — в её координатах с номером из полной;
// документ из одних скрытых не рисуется. Панель выделения — в подвале (`footer`, handoff M4,
// S6; R18): лента над ним не сдвигается.

/**
 * Тип данных перетаскивания — свой: с `text/plain` бросок на поле имени вставил бы в него
 * ключи страниц. Перетаскивание внутри окна, данные — только для порядка.
 */
const DRAG_TYPE = 'application/x-duplexnt-pages';

/** id поля имени документа `docIndex` (с нуля): подпись группы и фокус после границы. */
export const docNameId = (docIndex: number): string => `doc-name-${String(docIndex)}`;

/** id заголовка группы набора — подпись её listbox. */
const setTitleId = (side: SetSide): string => `set-${side}-title`;

/**
 * Куда ляжет бросок: перед/после миниатюры (маркер на ней), на разделитель наборов (верх — в
 * конец лиц, низ — в начало оборотов) или в зону пустой группы (M3.6, S2–S3).
 */
type Drop =
  | { readonly kind: 'thumb'; readonly key: string; readonly side: DropSide }
  | { readonly kind: 'divider'; readonly side: SetSide }
  | { readonly kind: 'group'; readonly side: SetSide };

/**
 * Поле имени документа (S3): ввод локален, фиксация — по Enter или уходу фокуса одним
 * `setEdits`; Esc возвращает сохранённое значение. Отправленное имя показывается до снимка с
 * ним — без мелькания прежнего; команда завершилась (снимок, отказ) — поле снова показывает
 * снимок. Команда не ушла (другая в полёте, запись) — черновик остаётся в поле и уйдёт
 * следующим Enter или уходом фокуса.
 */
function DocName({
  index,
  value,
  placeholder,
  disabled,
  busy,
  onCommit,
  onEnter,
}: {
  readonly index: number;
  readonly value: string;
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly onCommit: (docIndex: number, name: string) => boolean;
  /** Enter зафиксировал имя: фокус уходит из поля — на карточку текущей страницы (M3.5, S14). */
  readonly onEnter: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<{ readonly text: string; readonly sent: boolean } | null>(
    null,
  );
  if (draft?.sent === true && !busy) {
    setDraft(null);
  }

  const commit = (): void => {
    if (draft === null || draft.sent) {
      return;
    }
    if (draft.text === value) {
      setDraft(null);
      return;
    }
    if (onCommit(index, draft.text)) {
      setDraft({ text: draft.text, sent: true });
    }
  };

  const keyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      // Команда в полёте — черновик не отправить; фокус остаётся в поле, иначе имя выглядело
      // бы принятым, а в журнал не попало бы (код-ревью сессий 3–4).
      if (busy) {
        return;
      }
      // Enter «закрывает» ввод (замечание приёмки M3): уход фокуса фиксирует имя, как и
      // раньше (один `setEdits`), затем фокус уходит на ленту — следующий шаг человека там.
      event.currentTarget.blur();
      onEnter();
    } else if (event.key === 'Escape') {
      // Esc в поле — отмена ввода, а не сжатие выделения ленты; фокус остаётся в поле.
      event.stopPropagation();
      if (draft?.sent !== true) {
        setDraft(null);
      }
    }
  };

  return (
    <input
      id={docNameId(index)}
      className="doc-group__name"
      type="text"
      value={draft?.text ?? value}
      placeholder={placeholder}
      maxLength={MAX_DOCUMENT_NAME_LENGTH}
      aria-label={t('editor.doc.nameLabel', { number: index + 1 })}
      disabled={disabled}
      onChange={(event) => {
        setDraft({ text: event.target.value, sent: false });
      }}
      onBlur={commit}
      onKeyDown={keyDown}
    />
  );
}

/** Фокус на карточку страницы по ключу — одно место для селектора карточки в ленте. */
export const focusThumb = (rail: HTMLElement | null, key: string): void => {
  rail?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
};

export interface EditorRailProps {
  readonly sessionId: string;
  /** Показанная лента (M4, R11). */
  readonly order: readonly AssembledPage[];
  /** Документы в координатах показанной ленты; `index` — номер в полной (имена, разрезы, тон). */
  readonly documents: readonly ShownDocument[];
  /** Лента пуста, потому что все страницы — скрытые пустые обороты (S7 M4). */
  readonly allHidden: boolean;
  /** Группы ленты в режиме раздельных наборов (M3.6, R17); `null` — группы документов. */
  readonly sets: SetsLayout | null;
  /** Происхождение страницы по ключу — тег «об» и слова пары по проходу, не по группе (R11). */
  readonly origins: ReadonlyMap<string, PageOrigin>;
  /** Имена по умолчанию — плейсхолдеры полей имени (S3). */
  readonly defaultNames: readonly string[];
  readonly selection: Selection;
  /** Идёт запись (KTD-9): поля имени и «✕» недоступны. */
  readonly locked: boolean;
  /** Команда в полёте: отправленное имя ждёт снимка. */
  readonly busy: boolean;
  readonly railRef: RefObject<HTMLElement | null>;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  /** Стабильный: миниатюры под `memo`. */
  readonly onPick: (key: string, mode: PickMode) => void;
  readonly onSelect: (selection: Selection) => void;
  /** Граница перед позицией ленты (с нуля). */
  readonly onSplit: (position: number) => void;
  /** Снять границу перед документом (с нуля); `fromDivider` — «✕» разделителя, не split-бар. */
  readonly onUnsplit: (docIndex: number, fromDivider: boolean) => void;
  /** Имя документа (с нуля); `false` — команда не ушла. */
  readonly onRename: (docIndex: number, name: string) => boolean;
  readonly onMove: (keys: readonly string[], target: string, side: DropSide) => void;
  /** Бросок на разделитель наборов или в пустую группу: в конец лиц / в начало оборотов (KTD8). */
  readonly onMoveAcross: (keys: readonly string[], side: SetSide) => void;
  /** Подвал ленты: панель выделения, переключатель пустых, тумблер 180° (handoff M4, S4). */
  readonly footer: ReactNode;
}

export function EditorRail({
  sessionId,
  order,
  documents,
  allHidden,
  sets,
  origins,
  defaultNames,
  selection,
  locked,
  busy,
  railRef,
  onKeyDown,
  onPick,
  onSelect,
  onSplit,
  onUnsplit,
  onRename,
  onMove,
  onMoveAcross,
  footer,
}: EditorRailProps): ReactNode {
  const { t } = useTranslation();
  const total = order.length;
  /** Фокус на карточку текущей страницы — точку входа клавиатуры (роуминг `tabindex`). */
  const focusCurrent = (): void => {
    if (selection.current !== null) {
      focusThumb(railRef.current, selection.current);
    }
  };
  const selectedKeys = useMemo(() => new Set(selection.keys), [selection.keys]);
  const multi = selection.keys.length > 1;
  // Правки доступны сейчас: нет записи и команды в полёте — можно тянуть, split-бар виден.
  const editable = !locked && !busy;
  // Разрезы и имена — только вне режима наборов (M3.6, KTD8).
  const documentsEditable = sets === null;
  // Split-бар уступает выделению (M3.5, KTD-10): пока зажат Ctrl/Shift или выделено больше
  // одной страницы, бара нет — клик по верхнему краю миниатюры с модификатором выделяет.
  // Клавиши слушает окно: фокус в момент нажатия может быть где угодно.
  const [modifierHeld, setModifierHeld] = useState(false);
  useEffect(() => {
    const update = (event: globalThis.KeyboardEvent): void => {
      setModifierHeld(pickModifierHeld(event));
    };
    const release = (): void => {
      setModifierHeld(false);
    };
    window.addEventListener('keydown', update);
    window.addEventListener('keyup', update);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', update);
      window.removeEventListener('keyup', update);
      window.removeEventListener('blur', release);
    };
  }, []);

  // Позиция, перед которой стоит граница, → номер документа, который с неё начинается.
  const starts = useMemo(
    () =>
      new Map(
        documents
          .filter((doc) => doc.index > 0 && doc.count > 0)
          .map((doc) => [doc.start, doc.index]),
      ),
    [documents],
  );

  // Перетаскивание (S6): что тянут и где маркер вставки.
  const [dragged, setDragged] = useState<readonly string[] | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const draggedKeys = useMemo(() => new Set(dragged), [dragged]);

  const finishDrag = (): void => {
    setDragged(null);
    setDrop(null);
  };

  // Обработчики миниатюр — стабильные (`memo` не перерисовывает ленту на каждый `dragover`);
  // свежие выделение, лента и состояние переноса — через ref.
  const latest = useRef<ThumbDrag & { readonly split: (key: string) => void }>({
    split: () => undefined,
    start: () => undefined,
    over: () => undefined,
  });
  useLayoutEffect(() => {
    latest.current = {
      split: (key) => {
        const position = order.findIndex((entry) => entry.key === key);
        const docIndex = starts.get(position);
        if (docIndex === undefined) {
          onSplit(position);
        } else {
          onUnsplit(docIndex, false);
        }
      },
      start: (key, event) => {
        // Тянут выделенную из нескольких — едет всё выделение в порядке ленты; иначе одна
        // страница, и выделение переходит на неё.
        const group = multi && selectedKeys.has(key);
        const keys = group ? selection.keys : [key];
        if (!group) {
          onSelect(single(key));
        }
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(DRAG_TYPE, keys.join('\n'));
        setDragged(keys);
        setDrop(null);
      },
      over: (key, event) => {
        if (dragged === null) {
          return; // чужое перетаскивание — файлы, текст: лента его не принимает
        }
        event.stopPropagation();
        // Над перетаскиваемой страницей маркера нет: бросок туда ничего не делает.
        if (draggedKeys.has(key)) {
          if (drop !== null) {
            setDrop(null);
          }
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const rect = event.currentTarget.getBoundingClientRect();
        const side: DropSide = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
        if (drop?.kind !== 'thumb' || drop.key !== key || drop.side !== side) {
          setDrop({ kind: 'thumb', key, side });
        }
      },
    };
  });
  const drag = useMemo<ThumbDrag>(
    () => ({
      start: (key, event) => {
        latest.current.start(key, event);
      },
      over: (key, event) => {
        latest.current.over(key, event);
      },
    }),
    [],
  );
  const split = useMemo(
    () => (key: string) => {
      latest.current.split(key);
    },
    [],
  );

  // Цели дропа без страницы (M3.6, S2–S3): разделитель — половина по `clientY`, зона пустой
  // группы — целиком. Порядок ленты не меняется, меняется граница (`movedAcross`).
  const acceptDrop = (event: DragEvent<HTMLElement>, next: Drop): void => {
    if (dragged === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    if (drop?.kind !== next.kind || drop.side !== next.side) {
      setDrop(next);
    }
  };
  const dividerDragOver = (event: DragEvent<HTMLElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    const side: SetSide = event.clientY < rect.top + rect.height / 2 ? 'fronts' : 'backs';
    acceptDrop(event, { kind: 'divider', side });
  };

  // Зазоры между миниатюрами: бросок туда ложится на последний показанный маркер.
  const scrollDragOver = (event: DragEvent<HTMLElement>): void => {
    if (dragged !== null && drop !== null) {
      event.preventDefault();
    }
  };
  // Указатель ушёл из ленты — маркер гаснет: бросок вне ленты отменяет перенос.
  const scrollDragLeave = (event: DragEvent<HTMLElement>): void => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
      setDrop(null);
    }
  };
  const scrollDrop = (event: DragEvent<HTMLElement>): void => {
    if (dragged === null) {
      return;
    }
    event.preventDefault();
    if (drop?.kind === 'thumb') {
      onMove(dragged, drop.key, drop.side);
    } else if (drop !== null) {
      onMoveAcross(dragged, drop.side);
    }
    finishDrag();
  };

  const splitKind = (position: number): SplitKind =>
    position === 0 || !documentsEditable || !editable || multi || modifierHeld
      ? null
      : starts.has(position)
        ? 'remove'
        : 'add';

  /** Миниатюра страницы `entry` на позиции `position` ленты (с нуля) — одна на оба вида групп. */
  const thumbOf = (entry: AssembledPage, position: number): ReactNode => (
    <EditorThumb
      key={entry.key}
      sessionId={sessionId}
      pageKey={entry.key}
      origin={origins.get(entry.key)?.kind ?? null}
      side={entry.side}
      sheet={entry.sheet}
      angle={entry.angle}
      lost={entry.lost}
      blank={entry.blank}
      position={position + 1}
      inSets={sets !== null}
      addedSet={entry.addedSet}
      current={entry.key === selection.current}
      selected={selectedKeys.has(entry.key)}
      multi={multi && selectedKeys.has(entry.key)}
      draggable={editable}
      dragging={draggedKeys.has(entry.key)}
      drop={drop?.kind === 'thumb' && drop.key === entry.key ? drop.side : null}
      split={splitKind(position)}
      onPick={onPick}
      onSplit={split}
      drag={drag}
    />
  );

  /** Сетка миниатюр группы — один listbox на группу документа или набора. */
  const thumbList = (label: string, pages: readonly AssembledPage[], start: number): ReactNode => (
    <ul
      className="thumbs"
      role="listbox"
      aria-multiselectable="true"
      aria-orientation="horizontal"
      aria-label={label}
    >
      {pages.map((entry, offset) => thumbOf(entry, start + offset))}
    </ul>
  );

  /** S1, S3 M3.6: группа набора — заголовок с живым счётчиком, сетка или зона дропа. */
  const setGroup = (side: SetSide, start: number, pages: readonly AssembledPage[]): ReactNode => {
    const titleId = setTitleId(side);
    const pagesLabel = t(side === 'fronts' ? 'editor.sets.frontsPages' : 'editor.sets.backsPages');
    const empty = pages.length === 0;
    const active = drop?.kind === 'group' && drop.side === side;
    return (
      <section
        className={`set-group set-group--${side}${empty ? ' set-group--empty' : ''}`}
        aria-labelledby={titleId}
      >
        <div className="set-group__header">
          <h2 id={titleId} className="set-group__title">
            {t(side === 'fronts' ? 'editor.sets.fronts' : 'editor.sets.backs')}
          </h2>
          <span
            className="set-group__count"
            aria-label={t('editor.sets.countLabel', { count: pages.length })}
          >
            {t('editor.sets.count', { count: pages.length })}
          </span>
        </div>
        {empty ? (
          <div
            className={active ? 'set-group__drop set-group__drop--active' : 'set-group__drop'}
            role="listbox"
            aria-label={pagesLabel}
            onDragOver={(event) => {
              acceptDrop(event, { kind: 'group', side });
            }}
          >
            <span className="set-group__drop-text">
              {t(side === 'fronts' ? 'editor.sets.dropFronts' : 'editor.sets.dropBacks')}
            </span>
          </div>
        ) : (
          thumbList(pagesLabel, pages, start)
        )}
      </section>
    );
  };

  let groups: ReactNode;
  if (total === 0) {
    groups = (
      <p className="rail__empty">{t(allHidden ? 'editor.empty.railBlank' : 'editor.empty.rail')}</p>
    );
  } else if (sets !== null) {
    // S1–S2 M3.6: две группы по границе и разделитель между ними — цель дропа с маркером над
    // (в конец лиц) или под (в начало оборотов); сам разделитель не фокусируемый.
    const dividerClass =
      drop?.kind === 'divider'
        ? `set-divider set-divider--drop-${drop.side === 'fronts' ? 'above' : 'below'}`
        : 'set-divider';
    groups = (
      <>
        {setGroup('fronts', 0, order.slice(0, sets.divider))}
        <div
          className={dividerClass}
          role="separator"
          aria-label={t('editor.sets.dividerLabel')}
          onDragOver={dividerDragOver}
        >
          <span className="set-divider__rule" aria-hidden="true" />
          <span className="set-divider__hint">{t('editor.sets.divider')}</span>
          <span className="set-divider__rule" aria-hidden="true" />
        </div>
        {setGroup('backs', sets.divider, order.slice(sets.divider))}
      </>
    );
  } else {
    // S2: группа на документ, в каждой свой listbox; номер миниатюры — сквозной. Ключ —
    // первая страница документа: черновик имени едет с документом, а не с номером.
    groups = documents
      .filter((doc) => doc.count > 0)
      .map(({ index, ...doc }) => (
        <section
          key={order[doc.start]?.key ?? index}
          className={`doc-group ${toneOf(index)}`}
          aria-labelledby={docNameId(index)}
        >
          {index > 0 && (
            <div className="doc-group__divider">
              <span className="doc-group__pill">{t('editor.doc.newPill')}</span>
              <span className="doc-group__rule" aria-hidden="true" />
              <button
                type="button"
                className="doc-group__unsplit"
                title={t('editor.doc.unsplit')}
                aria-label={t('editor.doc.unsplitLabel', { number: index + 1 })}
                disabled={locked}
                onClick={() => {
                  onUnsplit(index, true);
                }}
              >
                ✕
              </button>
            </div>
          )}
          <div className="doc-group__header">
            <span className="doc-badge" aria-hidden="true">
              {index + 1}
            </span>
            <DocName
              key={order[doc.start]?.key ?? index}
              index={index}
              value={doc.name}
              placeholder={defaultNames[index] ?? ''}
              disabled={locked}
              busy={busy}
              onCommit={onRename}
              onEnter={focusCurrent}
            />
            <span className="doc-group__count">{t('editor.doc.count', { count: doc.count })}</span>
          </div>
          {thumbList(
            t('editor.doc.pagesLabel', { number: index + 1 }),
            order.slice(doc.start, doc.start + doc.count),
            doc.start,
          )}
        </section>
      ));
  }

  return (
    <aside className="rail" aria-label={t('editor.railLabel')} ref={railRef} onKeyDown={onKeyDown}>
      <div
        className="rail__scroll"
        onDragOver={scrollDragOver}
        onDragLeave={scrollDragLeave}
        onDrop={scrollDrop}
        onDragEnd={finishDrag}
      >
        {groups}
      </div>
      {footer}
    </aside>
  );
}
