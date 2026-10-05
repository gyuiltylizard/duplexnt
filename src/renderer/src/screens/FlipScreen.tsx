import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { DomainError, PassProgress, Snapshot } from '@shared';
import { LaunchFailureNotice } from '../components/LaunchFailureNotice';
import { multiline } from '../components/multiline';
import { useFocusWhen } from '../components/useFocusWhen';
import { reconnectAddress } from '../state/scanner-address';
import './flip-screen.css';

// Экран `flip` (план M2, U8; UI_SPEC раздел 4; handoff M2, S1–S3): кикер с числом листов,
// инструкция разворота, анимация `turn180`, чеклист из четырёх пунктов, запуск прохода
// оборотов и «Обороты не нужны». Состояние занятости S2 — KTD-11: кнопки заменяются на время
// ожидания, страницы пошли — экран сменится по снимку.

export interface FlipScreenProps {
  readonly snapshot: Snapshot;
  /** Идущий проход оборотов без страниц (S2); `null` — покой. Вывод — `screenOf` (KTD-5). */
  readonly pass: PassProgress | null;
  /** Отказ последнего запуска — плашка под действиями; живёт в App (потолок ретрая S2). */
  readonly launchFailure: DomainError | null;
  /** Запуск прохода оборотов — тот же `startPass`: роль решает политика ядра (KTD-4). */
  readonly onStart: () => void;
  /** «Подключить заново» из плашки отказа: иначе с `flip` в `device` не попасть (тупик). */
  readonly onOpenDevice: (initialAddress?: string) => void;
}

/** Пункты чеклиста в порядке показа; первый — про входной лоток (решение handoff M2). */
const CHECKS = ['tray', 'noFlip', 'keepOrder', 'stuck'] as const;

/**
 * Отказы, после которых с `flip` нужна кнопка в `device`: других путей к подключению на
 * экране нет. Шире списка `setup` (там есть строка устройства) и уже списка досканирования
 * в `editor` (`scannerUnreachable` здесь лечится повторным нажатием, не переподключением).
 */
const FLIP_RECONNECT_CODES: readonly string[] = [
  'scannerCertificateChanged',
  'scannerNotConnected',
];

export function FlipScreen({
  snapshot,
  pass,
  launchFailure,
  onStart,
  onOpenDevice,
}: FlipScreenProps): ReactNode {
  const { t } = useTranslation();
  const screenRef = useRef<HTMLElement>(null);
  const [declineFailure, setDeclineFailure] = useState<DomainError | null>(null);

  const busy = pass !== null;
  // В S2 обе кнопки недоступны — фокус уходит на контейнер экрана, как S15 M1.
  useFocusWhen(screenRef, busy);

  // Число листов — страницы лицевого прохода; отчёт сборки уже считает их по роли (KTD-4).
  const fronts = snapshot.assembly?.report.fronts ?? 0;

  const decline = (): void => {
    setDeclineFailure(null);
    window.api.declineBacks().then(
      (result) => {
        if (!result.ok) {
          setDeclineFailure(result.error);
        }
      },
      (error: unknown) => {
        console.error('[renderer] отказ от оборотов не ответил', error);
      },
    );
  };

  const start = (): void => {
    setDeclineFailure(null);
    onStart();
  };

  // Отказ «Обороты не нужны» — не запуск: его текст идёт без обёртки «Проход не начался…».
  const failure = declineFailure ?? launchFailure;

  return (
    <main className="flip-screen" ref={screenRef} tabIndex={-1}>
      <header className="flip-screen__intro">
        <div className="kicker">{t('flip.kicker', { count: fronts })}</div>
        <h1 className="flip-screen__title">{t('flip.title')}</h1>
        <p className="flip-screen__lead">{t('flip.lead')}</p>
      </header>

      <div className="flip-screen__card">
        <div className="flip-screen__demo">
          <div className="turn" aria-hidden="true">
            <div className="turn__shadows">
              <span className="turn__sheet turn__sheet--under" />
              <span className="turn__sheet turn__sheet--mid" />
            </div>
            <div className="turn__front">
              <span className="turn__arrow">↑</span>
              <span className="turn__top">{t('flip.illustrationTop')}</span>
              <span className="turn__lines">
                <span className="turn__line turn__line--1" />
                <span className="turn__line turn__line--2" />
                <span className="turn__line turn__line--3" />
              </span>
            </div>
            <span className="turn__tray" />
          </div>
          <div className="flip-screen__caption">{multiline(t('flip.illustration'))}</div>
        </div>

        <div className="flip-screen__divider" aria-hidden="true" />

        <ol className="flip-screen__checklist">
          {CHECKS.map((check) => (
            <li key={check} className="flip-screen__check">
              <span className="flip-screen__checkbox" aria-hidden="true">
                ✓
              </span>
              <span className="flip-screen__check-text">{t(`flip.check.${check}`)}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="flip-screen__actions">
        {busy ? (
          <>
            <button type="button" className="btn btn--primary btn--large" disabled aria-busy="true">
              {t('flip.busy.button')}
            </button>
            <p className="flip-screen__status" role="status" aria-live="polite">
              {t('flip.busy.text')}
            </p>
          </>
        ) : (
          <>
            <button type="button" className="btn btn--primary btn--large" onClick={start}>
              {t('flip.start')}
            </button>
            <button type="button" className="btn btn--link" onClick={decline}>
              {t('flip.skip')}
            </button>
            {failure !== null && (
              <LaunchFailureNotice
                error={failure}
                plain={declineFailure !== null}
                action={
                  FLIP_RECONNECT_CODES.includes(failure.code) ? (
                    <button
                      type="button"
                      className="btn btn--tinted"
                      onClick={() => {
                        onOpenDevice(reconnectAddress(snapshot.scanner));
                      }}
                    >
                      {t('setup.device.reconnect')}
                    </button>
                  ) : undefined
                }
              />
            )}
          </>
        )}
      </div>
    </main>
  );
}
