import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { DomainError } from '@shared';
import { Modal } from '../components/Modal';
import { useUnmounted } from '../components/useUnmounted';
import { errorText } from '../state/error-text';

// Модалка `newscan` (план M3, U9; handoff M3, S17; UI_SPEC §7.4): кикер и текст по состоянию
// набора — сохранён, есть несохранённое, лента пуста, но удалённые ещё можно вернуть. Удалённые
// пометкой страницы называются числом: закрытие сотрёт и их. Карточка «Сначала сохранить
// текущий» — только при несохранённом и непустой ленте. Начальный фокус — на «Остаться в
// документе». Пока идёт закрытие, карточки недоступны; успех уводит на `setup` по снимку, отказ
// оставляет сессию целой.

export interface NewScanModalProps {
  /** Страниц в ленте. */
  readonly total: number;
  /** Удалённых пометкой — их вернул бы Ctrl+Z или «Вернуть». */
  readonly deleted: number;
  readonly saved: boolean;
  readonly onSaveFirst: () => void;
  readonly onClose: () => void;
}

type Kind = 'saved' | 'unsaved' | 'empty';

const kindOf = (total: number, saved: boolean): Kind => {
  if (total === 0) {
    return 'empty';
  }
  return saved ? 'saved' : 'unsaved';
};

export function NewScanModal({
  total,
  deleted,
  saved,
  onSaveFirst,
  onClose,
}: NewScanModalProps): ReactNode {
  const { t } = useTranslation();
  const [closing, setClosing] = useState(false);
  const [failure, setFailure] = useState<DomainError | null>(null);
  const unmounted = useUnmounted();

  const kind = kindOf(total, saved);

  const confirm = (): void => {
    if (closing) {
      return;
    }
    setClosing(true);
    setFailure(null);
    window.api.closeSession().then(
      (result) => {
        if (unmounted.current) {
          return;
        }
        if (result.ok) {
          // Снимок без сессии сам уведёт на `setup`; закрытие — чтобы не ждать его.
          onClose();
          return;
        }
        setClosing(false);
        setFailure(result.error);
      },
      (error: unknown) => {
        console.error('[renderer] закрытие сессии не ответило', error);
        if (!unmounted.current) {
          setClosing(false);
        }
      },
    );
  };

  const text =
    kind === 'empty'
      ? t('newScan.text.empty', { count: deleted })
      : [
          t(`newScan.text.${kind}`, { count: total }),
          deleted > 0 ? t('newScan.text.deleted', { count: deleted }) : null,
        ]
          .filter((part) => part !== null)
          .join(' ');

  let status: ReactNode;
  if (closing) {
    status = (
      <p className="modal__status" role="status" aria-live="polite">
        {t('newScan.confirming')}
      </p>
    );
  } else if (failure !== null) {
    status = (
      <p className="modal__status modal__status--danger" role="alert">
        {errorText(t, failure)}
      </p>
    );
  } else {
    status = <p className="modal__status" />;
  }

  return (
    <Modal
      labelledBy="newscan-title"
      describedBy="newscan-text"
      small
      busy={closing}
      className="newscan-modal"
    >
      <header className="modal__header">
        <div className="modal__kicker">
          <span
            className={kind === 'saved' ? 'dot dot--accent' : 'dot dot--warning'}
            aria-hidden="true"
          />
          <span className={kind === 'saved' ? 'kicker kicker--accent' : 'kicker kicker--warning'}>
            {t(`newScan.kicker.${kind}`)}
          </span>
        </div>
        <h2 id="newscan-title" className="modal__title">
          {t('newScan.title')}
        </h2>
        <p id="newscan-text" className="modal__subtitle">
          {text}
        </p>
      </header>
      <div className="modal__body choices">
        <button type="button" className="choice" disabled={closing} onClick={confirm}>
          <span className="choice__sheet" aria-hidden="true" />
          <span className="choice__text">
            <span className="choice__title">{t('newScan.fresh')}</span>
            <span className="choice__note">
              {kind === 'unsaved'
                ? t('newScan.freshNote.unsaved', { count: total })
                : t('newScan.freshNote.saved')}
            </span>
          </span>
          <span className="choice__arrow" aria-hidden="true">
            →
          </span>
        </button>
        {kind === 'unsaved' && (
          <button type="button" className="choice" disabled={closing} onClick={onSaveFirst}>
            <span className="choice__sheet choice__sheet--accent" aria-hidden="true" />
            <span className="choice__text">
              <span className="choice__title">{t('newScan.saveFirst')}</span>
              <span className="choice__note">{t('newScan.saveFirstNote')}</span>
            </span>
            <span className="choice__arrow" aria-hidden="true">
              →
            </span>
          </button>
        )}
      </div>
      <footer className="modal__footer">
        {status}
        <button
          type="button"
          className="btn btn--ghost"
          autoFocus
          disabled={closing}
          onClick={onClose}
        >
          {t('newScan.stay')}
        </button>
      </footer>
    </Modal>
  );
}
