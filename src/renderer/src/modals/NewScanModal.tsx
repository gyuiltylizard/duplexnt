import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { DomainError } from '@shared';
import { Modal } from '../components/Modal';
import { errorText } from '../state/error-text';

// Модалка `newscan` (план M1, U24; handoff U19, S21): подтверждение, которое называет число
// удаляемых страниц. Начальный фокус — на «Отмена». Пока идёт удаление, обе кнопки недоступны;
// успех закрывает сессию, экран уходит на `setup` по снимку. Отказ оставляет сессию целой.

export interface NewScanModalProps {
  readonly pageCount: number;
  readonly onClose: () => void;
}

export function NewScanModal({ pageCount, onClose }: NewScanModalProps): ReactNode {
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState(false);
  const [failure, setFailure] = useState<DomainError | null>(null);
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  const confirm = (): void => {
    if (deleting) {
      return;
    }
    setDeleting(true);
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
        setDeleting(false);
        setFailure(result.error);
      },
      (error: unknown) => {
        console.error('[renderer] закрытие сессии не ответило', error);
        if (!unmounted.current) {
          setDeleting(false);
        }
      },
    );
  };

  let status: ReactNode;
  if (deleting) {
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
    <Modal labelledBy="newscan-title" small className="newscan-modal">
      <header className="modal__header">
        <div className="modal__kicker">
          <span className="dot dot--warning" aria-hidden="true" />
          <span className="kicker kicker--warning">{t('newScan.kicker')}</span>
        </div>
        <h2 id="newscan-title" className="modal__title">
          {t('newScan.title')}
        </h2>
        <p className="modal__subtitle">{t('newScan.text', { count: pageCount })}</p>
      </header>
      <footer className="modal__footer">
        {status}
        <button
          type="button"
          className="btn btn--ghost"
          autoFocus
          disabled={deleting}
          onClick={onClose}
        >
          {t('newScan.cancel')}
        </button>
        <button
          type="button"
          className="btn btn--primary btn--small"
          disabled={deleting}
          aria-busy={deleting ? true : undefined}
          onClick={confirm}
        >
          {t('newScan.confirm')}
        </button>
      </footer>
    </Modal>
  );
}
