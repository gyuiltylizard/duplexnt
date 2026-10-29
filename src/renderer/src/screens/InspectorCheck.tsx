import type { ReactNode } from 'react';

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
