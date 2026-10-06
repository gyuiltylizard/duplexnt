import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { DomainError, ScannerInfo, SessionSnapshot, Snapshot } from '@shared';
import { errorText, errorTextInline } from '../state/error-text';
import { addressOf, reconnectAddress } from '../state/scanner-address';

// Плашка прерванного прохода в `editor` (план M1, U24; handoff U19, S17): досканировать остаток,
// оставить как есть или начать новое сканирование; отказы — строкой под кнопками. Вынесена из
// `EditorScreen` (M3, U8): экран рос правками.

/**
 * Коды отказа досканирования, которые лечатся повторным подключением (S17). Список шире, чем
 * у плашки `flip`: досканировать можно только на сканере прохода (KTD-27), поэтому и
 * «не отвечает» ведёт к переподключению.
 */
const RESUME_RECONNECT_CODES: readonly string[] = [
  'scannerUnreachable',
  'scannerCertificateChanged',
];

export interface EditorPassBannerProps {
  readonly snapshot: Snapshot;
  readonly session: SessionSnapshot;
  /** Отказ последнего досканирования — живёт в App: экран на время прохода уходит. */
  readonly resumeFailure: DomainError | null;
  readonly onResume: () => void;
  readonly onOpenDevice: (initialAddress?: string) => void;
  readonly onNewScan: () => void;
}

export function EditorPassBanner({
  snapshot,
  session,
  resumeFailure,
  onResume,
  onOpenDevice,
  onNewScan,
}: EditorPassBannerProps): ReactNode {
  const { t } = useTranslation();
  const [acceptFailure, setAcceptFailure] = useState<DomainError | null>(null);

  const accept = (): void => {
    setAcceptFailure(null);
    window.api.acceptPass().then(
      (result) => {
        if (!result.ok) {
          setAcceptFailure(result.error);
        }
      },
      (error: unknown) => {
        console.error('[renderer] принятие прохода не ответило', error);
      },
    );
  };

  const resume = (): void => {
    setAcceptFailure(null);
    onResume();
  };

  const reconnect = (): void => {
    onOpenDevice(reconnectAddress(snapshot.scanner));
  };

  // «Подключите заново» из текста плашки — с адресом сканера прохода: именно его и надо
  // вернуть, чтобы досканировать (KTD-27).
  const reconnectPassScanner = (scanner: ScannerInfo | null): void => {
    onOpenDevice(scanner === null ? undefined : addressOf(scanner));
  };

  // Плашка S17: последний проход прерван. Ноль страниц проход иметь не может — сессии бы не было.
  const last = session.passes[session.passes.length - 1];
  if (last?.state !== 'interrupted') {
    return null;
  }
  const lastNumber = last.pages[last.pages.length - 1]?.number ?? 0;
  // Текст без кнопки досканирования объясняет почему; при «подключён не тот (или никакой)»
  // ссылка ведёт в `device` с адресом сканера прохода — иначе из `editor` в модалку не
  // попасть и проход не досканировать (тупик, ревью сессии 9; текст ссылки — Copy).
  const text: ReactNode = snapshot.canResume ? (
    t('editor.interrupted.text', { next: lastNumber + 1 })
  ) : last.paramsKnown ? (
    <>
      {t('editor.interrupted.textOtherScanner', {
        name: last.scanner?.name ?? last.scanner?.host ?? '',
      })}{' '}
      <button
        type="button"
        className="btn btn--link"
        onClick={() => {
          reconnectPassScanner(last.scanner);
        }}
      >
        {t('editor.interrupted.reconnect')}
      </button>
    </>
  ) : (
    t('editor.interrupted.textParamsUnknown')
  );
  // Свежий отказ «Оставить как есть» виден и под висящим отказом досканирования:
  // показывается последнее действие, а не первое.
  let failureLine: ReactNode = null;
  if (acceptFailure !== null) {
    failureLine = errorText(t, acceptFailure);
  } else if (resumeFailure !== null) {
    failureLine = (
      <>
        {t('editor.interrupted.resumeFailed', { error: errorTextInline(t, resumeFailure) })}
        {RESUME_RECONNECT_CODES.includes(resumeFailure.code) && (
          <>
            {' '}
            <button type="button" className="btn btn--link" onClick={reconnect}>
              {t('editor.interrupted.reconnect')}
            </button>
          </>
        )}
      </>
    );
  }
  return (
    <div className="pass-banner" role="region" aria-labelledby="pass-banner-title">
      <div className="pass-banner__kicker">
        <span className="dot dot--warning" aria-hidden="true" />
        <span className="kicker kicker--warning">{t('editor.interrupted.kicker')}</span>
      </div>
      <h2 id="pass-banner-title" className="pass-banner__title">
        {t('editor.interrupted.title', { last: lastNumber })}
      </h2>
      <p className="pass-banner__text">{text}</p>
      <div className="pass-banner__actions">
        {snapshot.canResume && (
          <button type="button" className="btn btn--primary btn--small" onClick={resume}>
            {t('editor.interrupted.resume')}
          </button>
        )}
        {snapshot.canAccept && (
          <button type="button" className="btn btn--tinted" onClick={accept}>
            {t('editor.interrupted.accept')}
          </button>
        )}
        <button type="button" className="btn btn--ghost" onClick={onNewScan}>
          {t('editor.interrupted.newScan')}
        </button>
      </div>
      {failureLine !== null && (
        <p className="pass-banner__status pass-banner__status--danger" role="alert">
          {failureLine}
        </p>
      )}
    </div>
  );
}
