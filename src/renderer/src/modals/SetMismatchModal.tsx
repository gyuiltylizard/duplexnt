import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AddedSetReport, DomainError } from '@shared';
import { Modal } from '../components/Modal';
import { errorTextInline } from '../state/error-text';

// Модалка несовпадения набора (план M4.5, U6; R15; handoff M4.5, S7): обороты двустороннего
// набора «ДN» завершились с числом, не равным числу лиц, решения ещё нет. Два действия и ни
// одного «закрыть»: «Переснять обороты набора» — ядро отбрасывает проход оборотов с правками
// по его страницам и экран уходит на `flip` набора; «Оставить как есть» — `kept`, подблоки
// остаются. Esc и подложка не закрывают (как `mismatch` M3.6); показ выводится из снимка в App
// (`setMismatchDue`), закрытие — ответом ядра: снимок после решения предикат не проходит. Фокус
// — на «Оставить как есть» (безопасное действие); «Переснять» — `btn--tinted`: отброс страниц
// не должен запускаться случайным Enter (решение handoff).

export interface SetMismatchModalProps {
  readonly set: AddedSetReport;
}

type Action = 'rescan' | 'keep';

export function SetMismatchModal({ set }: SetMismatchModalProps): ReactNode {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<Action | null>(null);
  const [failure, setFailure] = useState<{
    readonly action: Action;
    readonly error: DomainError | null;
  } | null>(null);
  // Фокус — на «Оставить как есть» (решение handoff). `autoFocus` недостаточно: модалка
  // монтируется вместе с `editor` после паузы, и его посадка уводит фокус на миниатюру, а ловушка
  // `Modal` вернула бы его на первую кнопку — «Переснять». Эффект родителя идёт последним.
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    keepRef.current?.focus();
  }, []);

  const run = (action: Action): void => {
    if (busy !== null) {
      return;
    }
    setBusy(action);
    setFailure(null);
    const request = { set: set.set };
    const command =
      action === 'rescan' ? window.api.rescanSetBacks(request) : window.api.keepSetBacks(request);
    command.then(
      (result) => {
        // Успех закрывает модалку снимком; занятость держится, чтобы второй клик не ушёл.
        if (!result.ok) {
          setBusy(null);
          setFailure({ action, error: result.error });
        }
      },
      (error: unknown) => {
        console.error('[renderer] решение по набору не ответило', error);
        setBusy(null);
        setFailure({ action, error: null });
      },
    );
  };

  let failureText: string | null = null;
  if (failure !== null) {
    const error =
      failure.error === null ? t('toast.closeNoResponse') : errorTextInline(t, failure.error);
    failureText = t(
      failure.action === 'rescan' ? 'setMismatch.rescanFailed' : 'setMismatch.keepFailed',
      { error },
    );
  }

  return (
    <Modal
      labelledBy="set-mismatch-title"
      describedBy="set-mismatch-text"
      small
      busy={busy !== null}
      className="mismatch-modal set-modal"
    >
      <header className="modal__header">
        <div className="modal__kicker">
          <span className="dot dot--warning" aria-hidden="true" />
          <span className="kicker kicker--warning">{t('setMismatch.kicker')}</span>
        </div>
        <h2 id="set-mismatch-title" className="modal__title">
          {t('setMismatch.title', { set: set.set, fronts: set.fronts, backs: set.backs })}
        </h2>
        <p id="set-mismatch-text" className="modal__subtitle">
          {t('setMismatch.text', { count: set.backs })}
        </p>
      </header>
      <footer className="modal__footer modal__footer--end">
        {failureText !== null && (
          <p className="modal__status modal__status--danger" role="alert">
            {failureText}
          </p>
        )}
        <button
          type="button"
          className="btn btn--tinted btn--small"
          disabled={busy !== null}
          aria-busy={busy === 'rescan' ? true : undefined}
          onClick={() => {
            run('rescan');
          }}
        >
          {busy === 'rescan' ? t('setMismatch.rescanBusy') : t('setMismatch.rescan')}
        </button>
        <button
          type="button"
          className="btn btn--primary btn--small"
          disabled={busy !== null}
          aria-busy={busy === 'keep' ? true : undefined}
          ref={keepRef}
          onClick={() => {
            run('keep');
          }}
        >
          {t('setMismatch.keep')}
        </button>
      </footer>
    </Modal>
  );
}
