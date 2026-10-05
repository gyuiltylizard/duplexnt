import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { DomainError } from '@shared';
import { errorText, errorTextInline } from '../state/error-text';

// Плашка отказа запуска прохода — одна на `setup` (S6) и `flip` (S2): уровень, обёртка
// «Проход не начался: …» и место дополнительной кнопки решаются здесь, а не на каждом экране.

/**
 * Коды, чей текст — самостоятельная фраза с инструкцией: обёртка им только мешает.
 * «Нет бумаги» — предупреждение, не ошибка.
 */
const STANDALONE_CODES: readonly string[] = ['scanNoPaper', 'scannerBusy'];

export interface LaunchFailureNoticeProps {
  readonly error: DomainError;
  /** Текст без обёртки «Проход не начался…» — для отказов, которые не были запуском. */
  readonly plain?: boolean;
  /** Кнопка действия («Подключить заново») — решает экран: пути к `device` у них разные. */
  readonly action?: ReactNode;
}

export function LaunchFailureNotice({ error, plain, action }: LaunchFailureNoticeProps): ReactNode {
  const { t } = useTranslation();
  return (
    <div
      className={error.code === 'scanNoPaper' ? 'notice notice--warning' : 'notice notice--danger'}
      role="alert"
    >
      <p className="notice__text">
        {plain === true || STANDALONE_CODES.includes(error.code)
          ? errorText(t, error)
          : t('launch.failed', { error: errorTextInline(t, error) })}
      </p>
      {action}
    </div>
  );
}
