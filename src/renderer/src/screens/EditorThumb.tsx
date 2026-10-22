import { memo, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { pageImageUrl, type AssembledPage, type PageAngle } from '@shared';
import type { TFunction } from 'i18next';
import { useImageLoad } from '../components/useImageLoad';
import type { DropSide } from '../state/edits';
import { whatOf } from '../state/page-text';

/** Как выбрали миниатюру: клик, Shift — диапазон, Ctrl — по одной (handoff M3, S4). */
export type PickMode = 'single' | 'range' | 'toggle';

/** Split-бар миниатюры (S7): поставить границу перед ней или снять стоящую; `null` — нет. */
export type SplitKind = 'add' | 'remove' | null;

/** Перетаскивание (S6): обработчики ленты, стабильные — `memo` миниатюр их переживает. */
export interface ThumbDrag {
  readonly start: (key: string, event: DragEvent<HTMLElement>) => void;
  readonly over: (key: string, event: DragEvent<HTMLElement>) => void;
}

/** Клавиши-модификаторы события — общее у мыши и клавиатуры, React и DOM. */
interface ModifierKeys {
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

const modeOf = (event: ModifierKeys): PickMode =>
  event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'single';

/** Зажат модификатор выделения (Shift / Ctrl / ⌘) — правило одно на клик и на клавиши. */
export const pickModifierHeld = (event: ModifierKeys): boolean => modeOf(event) !== 'single';

/**
 * Имя карточки для скринридера — по самому важному: потеря, затем режим наборов («Страница 15,
 * оборотная, 3-я в наборе оборотов» — M3.6, S9), добавленный набор (у его страницы нет ни
 * «лица», ни «оборота» — её называет набор, S5), иначе номер.
 */
function thumbLabelOf(
  t: TFunction,
  page: {
    readonly lost: boolean;
    readonly inSets: boolean;
    readonly side: AssembledPage['side'];
    readonly sheet: number | null;
    readonly addedSet: number | null;
    readonly position: number;
  },
): string {
  if (page.lost) {
    return t('thumb.lostLabel', { number: page.position });
  }
  if (page.inSets) {
    const { side, sheet, addedSet } = page;
    return t('thumb.setLabel', {
      number: page.position,
      what: whatOf(t, { side, sheet, addedSet }, 'sets'),
    });
  }
  if (page.addedSet !== null) {
    return t('thumb.addedLabel', { number: page.position, set: page.addedSet });
  }
  return t('thumb.alt', { number: page.position });
}

/**
 * Миниатюра в ленте: обычная, потерянная (S18 M1), строится или не построилась (S19 M1),
 * страница прохода оборотов с тегом «об» (по происхождению — R11 M3.6), угол из ядра (S4 M3),
 * перетаскивание с маркером вставки (S6 M3), split-бар границы (S7 M3), страница
 * добавленного набора с тегом «Д1» (S5 M3.5).
 * Пропсы — примитивы, чтобы `memo` переживал новый снимок (объекты порядка пересоздаются
 * десериализацией IPC): тумблер и отметка сохранения не перерисовывают всю ленту, смена
 * выделения — только затронутые карточки.
 */
export const EditorThumb = memo(function EditorThumb({
  sessionId,
  pageKey,
  backsOrigin,
  side,
  sheet,
  angle,
  lost,
  position,
  inSets,
  addedSet,
  current,
  selected,
  multi,
  draggable,
  dragging,
  drop,
  split,
  onPick,
  onSplit,
  drag,
}: {
  readonly sessionId: string;
  readonly pageKey: string;
  /** Страница прохода оборотов — тег «об» по происхождению, в любой группе (R11). */
  readonly backsOrigin: boolean;
  /** Сторона и номер по режиму (R11) — подпись карточки в режиме наборов. */
  readonly side: AssembledPage['side'];
  readonly sheet: number | null;
  /** Угол страницы из ядра (KTD-4): только отображение, файлы не меняются. */
  readonly angle: PageAngle;
  readonly lost: boolean;
  /** Номер по порядку в ленте, с единицы — сквозной через документы и группы. */
  readonly position: number;
  /** Режим наборов: подпись — «что это за страница» теми же словами, что ДЕТАЛИ (KTD9). */
  readonly inSets: boolean;
  /** Номер добавленного набора от 1 (KTD-4) — тег «Д{{set}}»; `null` — лицо или оборот. */
  readonly addedSet: number | null;
  /** Текущая — её показывает превью; точка входа клавиатуры (роуминг `tabindex`). */
  readonly current: boolean;
  /** В выделении (`aria-selected`). */
  readonly selected: boolean;
  /** В выделении из нескольких страниц — тёмная рамка и кольцо. */
  readonly multi: boolean;
  /** Правки доступны — миниатюру можно тянуть (S6). */
  readonly draggable: boolean;
  /** Её тянут — сама или в составе выделения. */
  readonly dragging: boolean;
  /** Маркер вставки над ней: перед или после; `null` — маркера нет. */
  readonly drop: DropSide | null;
  readonly split: SplitKind;
  readonly onPick: (key: string, mode: PickMode) => void;
  readonly onSplit: (key: string) => void;
  readonly drag: ThumbDrag;
}): ReactNode {
  const { t } = useTranslation();
  const image = useImageLoad();

  const click = (event: MouseEvent<HTMLElement>): void => {
    onPick(pageKey, modeOf(event));
  };
  const splitClick = (event: MouseEvent<HTMLElement>): void => {
    // Клик с модификатором по зоне бара — выделение, не граница (M3.5, KTD-10): всплывает до
    // карточки и уходит в `onPick`. Бар при зажатом модификаторе и так скрыт — это страховка на
    // случай, когда нажатие клавиши лента не видела.
    if (pickModifierHeld(event)) {
      return;
    }
    // Split-бар внутри карточки: клик по нему — граница, а не выбор страницы.
    event.stopPropagation();
    onSplit(pageKey);
  };
  const keyDown = (event: KeyboardEvent<HTMLElement>): void => {
    // Ctrl+Space — переключение текущей в выделении: его ведёт лента (handoff M3, клавиатура).
    if ((event.key === 'Enter' || event.key === ' ') && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      onPick(pageKey, event.shiftKey ? 'range' : 'single');
    }
  };

  const classes = ['thumb'];
  let paper: ReactNode;
  if (lost) {
    classes.push('thumb--lost');
    paper = <span className="thumb__label">{t('thumb.lost')}</span>;
  } else if (image.state === 'failed') {
    classes.push('thumb--failed');
    paper = <span className="thumb__label">{t('thumb.failed')}</span>;
  } else {
    if (image.state === 'loading') {
      classes.push('thumb--loading');
    }
    paper = (
      <>
        <img
          className="thumb__img"
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          src={pageImageUrl(sessionId, 'thumb', pageKey)}
          onLoad={image.onLoad}
          onError={image.onError}
        />
        {image.state === 'loading' && <span className="skeleton skeleton--cover" />}
      </>
    );
  }
  if (current) {
    classes.push('thumb--selected');
  }
  if (multi) {
    classes.push('thumb--in-selection');
  }
  if (angle !== 0) {
    classes.push(`thumb--angle-${String(angle)}`);
  }
  if (dragging) {
    classes.push('thumb--dragging');
  }

  const base = thumbLabelOf(t, { lost, inSets, side, sheet, addedSet, position });
  const label = angle === 0 ? base : `${base}, ${t('thumb.angle', { angle })}`;

  return (
    <li
      role="option"
      aria-selected={selected}
      aria-busy={!lost && image.state === 'loading' ? true : undefined}
      aria-label={label}
      title={!lost && image.state === 'failed' ? t('thumb.failedTitle') : undefined}
      tabIndex={current ? 0 : -1}
      data-key={pageKey}
      className={classes.join(' ')}
      draggable={draggable}
      onClick={click}
      onKeyDown={keyDown}
      onDragStart={(event) => {
        drag.start(pageKey, event);
      }}
      onDragOver={(event) => {
        drag.over(pageKey, event);
      }}
    >
      {/* S7: только мышь — вне обхода и дерева доступности; с клавиатуры граница ставится
          кнопкой тулбара и снимается «✕» разделителя. */}
      {split !== null && (
        <button
          type="button"
          className={split === 'remove' ? 'thumb__split thumb__split--remove' : 'thumb__split'}
          tabIndex={-1}
          aria-hidden="true"
          title={split === 'remove' ? t('editor.doc.unsplit') : t('thumb.splitTitle')}
          onClick={splitClick}
        >
          {split === 'remove' ? t('thumb.unsplit') : t('thumb.split')}
        </button>
      )}
      {drop !== null && <span className={`thumb__drop thumb__drop--${drop}`} aria-hidden="true" />}
      <div className="thumb__paper">{paper}</div>
      <div className="thumb__foot">
        <span className="thumb__num">{position}</span>
        {backsOrigin && <span className="thumb__tag">{t('thumb.tagBacks')}</span>}
        {addedSet !== null && (
          <span
            className="thumb__tag thumb__tag--added"
            aria-label={t('thumb.tagAddedLabel', { set: addedSet })}
          >
            {t('thumb.tagAdded', { set: addedSet })}
          </span>
        )}
      </div>
    </li>
  );
});
