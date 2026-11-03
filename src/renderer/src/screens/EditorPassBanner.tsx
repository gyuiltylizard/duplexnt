import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  isPairKind,
  isMainKind,
  type DomainError,
  type ErrorCode,
  type PassSnapshot,
  type ScannerInfo,
  type SessionSnapshot,
  type Snapshot,
} from '@shared';
import type { TFunction } from 'i18next';
import { errorText, errorTextInline } from '../state/error-text';
import { addressOf, isPassReplaced, reconnectAddress } from '../state/scanner-address';
import { setOfPass } from '../state/screen';

// Плашка прерванного прохода в `editor` (план M1, U24; handoff U19, S17): досканировать остаток,
// оставить как есть или начать новое сканирование; отказы — строкой под кнопками. У прерванного
// добавленного набора — свои заголовок и текст (M3.5, handoff S4); у прерванных лиц и оборотов
// двустороннего набора «ДN» — свои заголовки (M4.5, R5, R7; handoff M4.5, S10); остальное общее.

/**
 * Коды отказа досканирования, которые лечатся повторным подключением (S17). Список шире, чем
 * у плашки `flip`: досканировать можно только на сканере прохода (KTD-27), поэтому и
 * «не отвечает» ведёт к переподключению.
 */
const RESUME_RECONNECT_CODES: readonly ErrorCode[] = [
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

/** Заголовок плашки по роли прерванного прохода; у набора «ДN» — с его номером и ожиданием. */
function titleOf(t: TFunction, session: SessionSnapshot, last: PassSnapshot, lastNumber: number) {
  if (last.kind === 'added') {
    return t('editor.interrupted.titleAdded', { last: lastNumber });
  }
  if (isPairKind(last.kind)) {
    const set = setOfPass(session.passes, last.number);
    const setNumber = set?.set ?? 0;
    if (last.kind === 'addedFronts') {
      return t('editor.interrupted.titleSetFronts', { set: setNumber, last: lastNumber });
    }
    const expected = session.passes.find((pass) => pass.number === set?.fronts)?.pages.length ?? 0;
    return t('editor.interrupted.titleSetBacks', { set: setNumber, last: lastNumber, expected });
  }
  return t('editor.interrupted.title', { last: lastNumber });
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
  const acceptRef = useRef<HTMLButtonElement>(null);

  // Прерванный проход заменён подтверждённой сменой устройства (B-29, KTD-10): досканировать
  // нельзя, ссылка «подключите заново» бессмысленна — по этому адресу прежнего устройства нет.
  const last = session.passes[session.passes.length - 1];
  const replaced =
    last?.state === 'interrupted' &&
    !snapshot.canResume &&
    last.paramsKnown &&
    isPassReplaced(snapshot.scanner, last.scanner);

  // Плашка сменилась на «заменено» после подтверждения: фокус — на «Оставить как есть»
  // (handoff `scanner-change`, Behaviour); ссылка, с которой открывали модалку, исчезла.
  useEffect(() => {
    if (replaced) {
      acceptRef.current?.focus();
    }
  }, [replaced]);

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
  if (last?.state !== 'interrupted') {
    return null;
  }
  const lastNumber = last.pages[last.pages.length - 1]?.number ?? 0;
  // Текст без кнопки досканирования объясняет почему; при «подключён не тот (или никакой)»
  // ссылка ведёт в `device` с адресом сканера прохода — иначе из `editor` в модалку не
  // попасть и проход не досканировать (тупик, ревью сессии 9; текст ссылки — Copy).
  let text: ReactNode;
  if (snapshot.canResume) {
    const key =
      last.kind === 'added'
        ? 'editor.interrupted.textAdded'
        : isMainKind(last.kind)
          ? 'editor.interrupted.text'
          : 'editor.interrupted.textSet';
    text = t(key, { next: lastNumber + 1 });
  } else if (replaced) {
    text = t('editor.interrupted.textReplaced');
  } else if (last.paramsKnown) {
    text = (
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
    );
  } else {
    text = t('editor.interrupted.textParamsUnknown');
  }
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
        {titleOf(t, session, last, lastNumber)}
      </h2>
      <p className="pass-banner__text">{text}</p>
      <div className="pass-banner__actions">
        {snapshot.canResume && (
          <button type="button" className="btn btn--primary btn--small" onClick={resume}>
            {t('editor.interrupted.resume')}
          </button>
        )}
        {snapshot.canAccept && (
          <button ref={acceptRef} type="button" className="btn btn--tinted" onClick={accept}>
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
