import type { ReactNode } from 'react';

/**
 * Пункт ПРОВЕРКИ данными (B-45, KTD-4): свёрнутая строка ДЕТАЛЕЙ по `warning` знает, что в
 * проверке есть точка, не рендеря список.
 */
export interface CheckItem {
  readonly key: string;
  readonly warning: boolean;
  readonly text: ReactNode;
}

/** Строка ПРОВЕРКИ инспектора: ✓ — всё хорошо, • — стоит взглянуть. */
export function Check({
  warning,
  children,
}: {
  readonly warning: boolean;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <li className={warning ? 'check check--warning' : 'check'}>
      <span className="check__icon" aria-hidden="true">
        {warning ? '•' : '✓'}
      </span>
      <span className="check__text">{children}</span>
    </li>
  );
}
