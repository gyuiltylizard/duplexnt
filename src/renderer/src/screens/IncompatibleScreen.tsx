import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { DomainError } from '@shared';
import { errorText } from '../state/error-text';

// Экран несовместимых данных (S22): единственный экран, модалок и тостов над ним нет. Из него
// два выхода: открыть каталог данных в проводнике или выйти. Фокус при открытии — на первой
// кнопке (handoff U19 → Behaviour).

export function IncompatibleScreen(): ReactNode {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<DomainError | null>(null);
  const openRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    openRef.current?.focus();
  }, []);

  const openFolder = (): void => {
    setFailure(null);
    window.api.openDataFolder().then(
      (result) => {
        if (!result.ok) {
          setFailure(result.error);
        }
      },
      (error: unknown) => {
        console.error('[renderer] каталог данных не открыт', error);
      },
    );
  };

  return (
    <main className="incompatible-screen">
      <div className="incompatible-screen__column">
        <div className="kicker">{t('incompatible.kicker')}</div>
        <h1 className="incompatible-screen__title">{t('incompatible.title')}</h1>
        <p className="incompatible-screen__lead">{t('incompatible.lead')}</p>
        <div className="incompatible-screen__actions">
          <button
            ref={openRef}
            type="button"
            className="btn btn--primary btn--large"
            onClick={openFolder}
          >
            {t('incompatible.openFolder')}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              window.close();
            }}
          >
            {t('incompatible.quit')}
          </button>
        </div>
        {failure !== null && (
          <p className="incompatible-screen__status" role="alert">
            {errorText(t, failure)}
          </p>
        )}
      </div>
    </main>
  );
}
