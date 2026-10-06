import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { pageImageUrl, type AssembledPage } from '@shared';
import { multiline } from '../components/multiline';
import { useImageLoad } from '../components/useImageLoad';

/**
 * Превью: сама страница под углом из ядра (S8 M3: 90°/270° — альбомная бумага), кромка и метка
 * начала документа; потерянная — пунктирный лист S18 M1; не открылась — текст S19 M1.
 * Перемонтируется на каждую страницу (`key` по ключу) — так требует `useImageLoad`.
 */
export function EditorPreview({
  sessionId,
  entry,
  position,
  docStart,
  tone,
}: {
  readonly sessionId: string;
  readonly entry: AssembledPage;
  readonly position: number;
  /** Номер документа, который начинается с этой страницы (кроме первого); иначе `null`. */
  readonly docStart: number | null;
  /** Класс тона документа страницы (`doc-tone--N`). */
  readonly tone: string;
}): ReactNode {
  const { t } = useTranslation();
  const image = useImageLoad();

  // Потерянная страница и не открывшийся файл показываются одинаково устроенным листом:
  // угловая метка и текст; различаются пунктиром и ключом текста.
  if (entry.lost || image.state === 'failed') {
    return (
      <div className={entry.lost ? 'preview__paper preview__paper--lost' : 'preview__paper'}>
        <div className="preview__corner">{t('preview.corner', { number: position })}</div>
        <p className="preview__empty">
          {multiline(entry.lost ? t('preview.lost') : t('preview.failed'))}
        </p>
      </div>
    );
  }
  const classes = ['preview__paper', tone];
  if (image.state === 'loading') {
    classes.push('preview__paper--loading');
  }
  // Угол — только отображение (KTD-4): файлы не меняются, без анимации (handoff M3, движение).
  if (entry.angle !== 0) {
    classes.push(`preview__paper--angle-${String(entry.angle)}`);
  }
  if (entry.angle === 90 || entry.angle === 270) {
    classes.push('preview__paper--landscape');
  }
  if (docStart !== null) {
    classes.push('preview__paper--doc-start');
  }
  return (
    <div className={classes.join(' ')} aria-busy={image.state === 'loading' ? true : undefined}>
      {docStart !== null && (
        <span className="preview__doc-start">{t('preview.docStart', { number: docStart })}</span>
      )}
      <img
        className="preview__img"
        alt={t('thumb.alt', { number: position })}
        src={pageImageUrl(sessionId, 'page', entry.key)}
        onLoad={image.onLoad}
        onError={image.onError}
      />
      {image.state === 'loading' && <span className="skeleton skeleton--cover" />}
    </div>
  );
}
