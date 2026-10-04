import type { ReactNode } from 'react';

// Сегментированный выбор по рецепту дизайн-системы: ряд кнопок-радио, каждая в порядке обхода
// Tab (handoff U19 → Behaviour). Недоступный ряд показывает значения, но не принимает выбор:
// `aria-disabled` на группе, не `disabled` на кнопках (S2 — значения видны и в недоступном ряду).

export interface SegmentsProps<T extends string | number> {
  readonly label: string;
  readonly values: readonly T[];
  readonly selected: T | null;
  readonly disabled?: boolean;
  readonly format: (value: T) => string;
  readonly titleOf?: (value: T) => string | undefined;
  readonly onSelect: (value: T) => void;
}

export function Segments<T extends string | number>({
  label,
  values,
  selected,
  disabled,
  format,
  titleOf,
  onSelect,
}: SegmentsProps<T>): ReactNode {
  const off = disabled === true;
  return (
    <div className="segments" role="radiogroup" aria-label={label} aria-disabled={off || undefined}>
      {values.map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={value === selected}
          aria-disabled={off || undefined}
          className={value === selected ? 'segment segment--selected' : 'segment'}
          title={titleOf?.(value)}
          onClick={() => {
            if (!off) {
              onSelect(value);
            }
          }}
        >
          {format(value)}
        </button>
      ))}
    </div>
  );
}
