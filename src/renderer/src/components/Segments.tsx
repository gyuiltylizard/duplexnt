import type { KeyboardEvent, ReactNode } from 'react';

// Сегментированный выбор по рецепту дизайн-системы: ряд кнопок-радио. По умолчанию каждая в
// порядке обхода Tab (handoff U19 → Behaviour); `roving` — одна остановка Tab: в обходе
// выбранная, стрелки переводят выбор и фокус (handoff M3.5, «Клавиатура»). Недоступный ряд
// показывает значения, но не принимает выбор: `aria-disabled` на группе, не `disabled` на
// кнопках (S2 — значения видны и в недоступном ряду); недоступное одно значение —
// `disabledReason` с причиной в `title`, стрелками пропускается.

export interface SegmentsProps<T extends string | number> {
  readonly label?: string;
  /** `id` заголовка группы — вместо `label`, когда кикер секции уже на экране. */
  readonly labelledBy?: string;
  readonly values: readonly T[];
  readonly selected: T | null;
  readonly disabled?: boolean;
  readonly format: (value: T) => string;
  readonly titleOf?: (value: T) => string | undefined;
  /** Причина недоступности значения; `undefined` — доступно. */
  readonly disabledReason?: (value: T) => string | undefined;
  /** Одна остановка Tab, стрелки переводят выбор и фокус. */
  readonly roving?: boolean;
  /** Крупные сегменты (`segment--large`) в широком ряду (`segments--wide`). */
  readonly large?: boolean;
  readonly onSelect: (value: T) => void;
}

const STEP: Readonly<Record<string, 1 | -1>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * Стрелки в радиогруппе с одной остановкой Tab: выбор и фокус уходят на соседнее доступное
 * значение по кольцу (недоступные пропускаются). Кнопки группы несут `data-value`.
 */
export function rovingRadioKeyDown<T extends string | number>(
  event: KeyboardEvent<HTMLElement>,
  values: readonly T[],
  selected: T | null,
  enabled: (value: T) => boolean,
  onSelect: (value: T) => void,
): void {
  const step = STEP[event.key];
  if (step === undefined) {
    return;
  }
  event.preventDefault();
  const size = values.length;
  const start = selected === null ? 0 : values.indexOf(selected);
  for (let offset = 1; offset < size; offset += 1) {
    const candidate = values[(((start + step * offset) % size) + size) % size];
    if (candidate !== undefined && enabled(candidate)) {
      onSelect(candidate);
      event.currentTarget
        .closest('[role="radiogroup"]')
        ?.querySelector<HTMLElement>(`[data-value="${String(candidate)}"]`)
        ?.focus();
      return;
    }
  }
}

export function Segments<T extends string | number>({
  label,
  labelledBy,
  values,
  selected,
  disabled,
  format,
  titleOf,
  disabledReason,
  roving,
  large,
  onSelect,
}: SegmentsProps<T>): ReactNode {
  const off = disabled === true;
  const enabled = (value: T): boolean => !off && disabledReason?.(value) === undefined;
  return (
    <div
      className={large === true ? 'segments segments--wide' : 'segments'}
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-disabled={off || undefined}
    >
      {values.map((value) => {
        const reason = disabledReason?.(value);
        const classes = ['segment'];
        if (large === true) {
          classes.push('segment--large');
        }
        if (value === selected) {
          classes.push('segment--selected');
        }
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={value === selected}
            aria-disabled={off || reason !== undefined || undefined}
            tabIndex={roving === true ? (value === selected ? 0 : -1) : undefined}
            data-value={value}
            className={classes.join(' ')}
            title={reason ?? titleOf?.(value)}
            onClick={() => {
              if (enabled(value)) {
                onSelect(value);
              }
            }}
            onKeyDown={
              roving === true
                ? (event) => {
                    rovingRadioKeyDown(event, values, selected, enabled, onSelect);
                  }
                : undefined
            }
          >
            {format(value)}
          </button>
        );
      })}
    </div>
  );
}
