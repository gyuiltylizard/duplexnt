import { useTranslation } from 'react-i18next';
import type { StartupNotice } from '@shared';
import type { ReactNode } from 'react';

// Уведомления запуска (S20): полоса плашек под верхней кромкой окна на `setup` и `editor`.
// Не тост: уведомлений может быть несколько, и каждое важнее 2,6 с. «Понятно» убирает плашку до
// следующего запуска — закрытые помнит App, на диск это не пишется.

export interface NoticesBarProps {
  readonly notices: readonly StartupNotice[];
  readonly onDismiss: (notice: StartupNotice) => void;
}

export function NoticesBar({ notices, onDismiss }: NoticesBarProps): ReactNode {
  const { t } = useTranslation();
  if (notices.length === 0) {
    return null;
  }
  return (
    <div className="notices" role="region" aria-label={t('notices.label')}>
      {notices.map((notice) => (
        <div key={notice} className="notice notice--info" role="status">
          <p className="notice__text">{t(`notices.${notice}`)}</p>
          <button
            type="button"
            className="btn btn--tinted"
            onClick={() => {
              onDismiss(notice);
            }}
          >
            {t('notices.dismiss')}
          </button>
        </div>
      ))}
    </div>
  );
}
