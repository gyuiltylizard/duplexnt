import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../components/Modal';

// Модалка `revert` (план M3, U8; handoff M3, S14): подтверждение полного отката правок. Текст
// перечисляет, что сбрасывается, и напоминает про Ctrl+Z; начальный фокус — на «Отмена». Сам
// откат шлёт экран — одним `setEdits`, одним шагом undo.

export interface RevertModalProps {
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function RevertModal({ onCancel, onConfirm }: RevertModalProps): ReactNode {
  const { t } = useTranslation();

  return (
    <Modal
      labelledBy="revert-title"
      describedBy="revert-text"
      small
      className="revert-modal"
      onEscape={onCancel}
    >
      <header className="modal__header">
        <h2 id="revert-title" className="modal__title">
          {t('revert.title')}
        </h2>
        <p id="revert-text" className="modal__subtitle">
          {t('revert.text')}
        </p>
      </header>
      <footer className="modal__footer">
        <p className="modal__status" />
        <button type="button" className="btn btn--ghost" autoFocus onClick={onCancel}>
          {t('revert.cancel')}
        </button>
        <button type="button" className="btn btn--primary btn--small" onClick={onConfirm}>
          {t('revert.confirm')}
        </button>
      </footer>
    </Modal>
  );
}
