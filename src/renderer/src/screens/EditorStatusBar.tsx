import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { RotateDirection } from '../state/edits';

// Статус-бар превью (handoff M3, S9; M3.5, S13): листание «← N из M →», «↺» / «↻» и «Удалить»
// для текущей или всего выделения. Только показ и клики: подписи с числом страниц и сами
// правки считает экран.

export interface EditorStatusBarProps {
  readonly total: number;
  /** Позиция текущей, с нуля; −1 — ленты нет. */
  readonly currentIndex: number;
  /** Идёт запись или сборка (KTD-9): инструменты правок недоступны. */
  readonly locked: boolean;
  /** Подписи инструментов по выделению: «Повернуть 3 стр. …» или «Повернуть …». */
  readonly rotateLabel: string;
  readonly rotateLeftLabel: string;
  readonly deleteLabel: string;
  readonly onStep: (delta: -1 | 1) => void;
  readonly onRotate: (direction: RotateDirection) => void;
  readonly onRemove: () => void;
}

export function EditorStatusBar({
  total,
  currentIndex,
  locked,
  rotateLabel,
  rotateLeftLabel,
  deleteLabel,
  onStep,
  onRotate,
  onRemove,
}: EditorStatusBarProps): ReactNode {
  const { t } = useTranslation();
  return (
    <footer className="stage__statusbar">
      <button
        type="button"
        className="btn btn--icon"
        aria-label={t('editor.prev')}
        disabled={total === 0}
        aria-disabled={total > 0 && currentIndex <= 0 ? true : undefined}
        onClick={() => {
          onStep(-1);
        }}
      >
        ←
      </button>
      <div className="stage__counter">
        {total === 0
          ? t('editor.positionNone')
          : t('editor.position', { current: currentIndex + 1, total })}
      </div>
      <button
        type="button"
        className="btn btn--icon"
        aria-label={t('editor.next')}
        disabled={total === 0}
        aria-disabled={total > 0 && currentIndex >= total - 1 ? true : undefined}
        onClick={() => {
          onStep(1);
        }}
      >
        →
      </button>
      <span className="stage__divider" aria-hidden="true" />
      <button
        type="button"
        className="btn btn--icon stage__tool"
        aria-label={rotateLeftLabel}
        title={rotateLeftLabel}
        disabled={total === 0 || locked}
        onClick={() => {
          onRotate('ccw');
        }}
      >
        ↺
      </button>
      <button
        type="button"
        className="btn btn--icon stage__tool"
        aria-label={rotateLabel}
        title={rotateLabel}
        disabled={total === 0 || locked}
        onClick={() => {
          onRotate('cw');
        }}
      >
        ↻
      </button>
      <button
        type="button"
        className="btn btn--icon stage__tool stage__tool--danger"
        aria-label={deleteLabel}
        title={deleteLabel}
        disabled={total === 0 || locked}
        onClick={onRemove}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M2.5 3.6h9" />
          <path d="M5.6 3.6V2.4h2.8v1.2" />
          <path d="M3.7 3.6l.55 7.4h5.5l.55-7.4" />
          <path d="M5.9 5.8v3M8.1 5.8v3" />
        </svg>
      </button>
    </footer>
  );
}
