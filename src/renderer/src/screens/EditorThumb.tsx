import { memo, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { pageImageUrl, type AssembledPage, type PageAngle } from '@shared';
import { useImageLoad } from '../components/useImageLoad';

/** Как выбрали миниатюру: клик, Shift — диапазон, Ctrl — по одной (handoff M3, S4). */
export type PickMode = 'single' | 'range' | 'toggle';

const modeOf = (event: MouseEvent | KeyboardEvent): PickMode =>
  event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'single';

/**
 * Миниатюра в ленте: обычная, потерянная (S18 M1), строится или не построилась (S19 M1),
 * оборот с тегом «об», непарный лист с янтарной точкой (S6 M2), угол из ядра (S4 M3).
 * Пропсы — примитивы, чтобы `memo` переживал новый снимок (объекты порядка пересоздаются
 * десериализацией IPC): тумблер и отметка сохранения не перерисовывают всю ленту, смена
 * выделения — только затронутые карточки.
 */
export const EditorThumb = memo(function EditorThumb({
  sessionId,
  pageKey,
  side,
  sheet,
  angle,
  lost,
  position,
  unpaired,
  current,
  selected,
  multi,
  onPick,
}: {
  readonly sessionId: string;
  readonly pageKey: string;
  readonly side: AssembledPage['side'];
  readonly sheet: number | null;
  /** Угол страницы из ядра (KTD-4): только отображение, файлы не меняются. */
  readonly angle: PageAngle;
  readonly lost: boolean;
  /** Номер по порядку в ленте, с единицы — сквозной через документы. */
  readonly position: number;
  readonly unpaired: boolean;
  /** Текущая — её показывает превью; точка входа клавиатуры (роуминг `tabindex`). */
  readonly current: boolean;
  /** В выделении (`aria-selected`). */
  readonly selected: boolean;
  /** В выделении из нескольких страниц — тёмная рамка и кольцо. */
  readonly multi: boolean;
  readonly onPick: (key: string, mode: PickMode) => void;
}): ReactNode {
  const { t } = useTranslation();
  const image = useImageLoad();

  const click = (event: MouseEvent<HTMLElement>): void => {
    onPick(pageKey, modeOf(event));
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

  const base = lost
    ? t('thumb.lostLabel', { number: position })
    : unpaired
      ? t('thumb.unpairedLabel', { number: sheet ?? position })
      : t('thumb.alt', { number: position });
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
      onClick={click}
      onKeyDown={keyDown}
    >
      <div className="thumb__paper">{paper}</div>
      <div className="thumb__foot">
        <span className="thumb__num">{position}</span>
        {side === 'back' && <span className="thumb__tag">{t('thumb.tagBacks')}</span>}
        {unpaired && (
          <span
            className="dot dot--warning thumb__flag"
            title={t('thumb.unpairedTitle')}
            aria-hidden="true"
          />
        )}
      </div>
    </li>
  );
});
