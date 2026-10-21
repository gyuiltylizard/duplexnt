import type { SetsLayout } from '@shared';
import type { TFunction } from 'i18next';

// Доступность «Собрать документ» (план M3.6, U6; handoff M3.6, S5; R19): первая причина по
// фиксированному порядку таблицы — в `title` недоступной кнопки. Чистая функция, чтобы порядок
// причин жил в одном месте и проверялся без экрана.

/** Причина недоступности — по порядку таблицы S5. */
export type AssembleBlock =
  'saving' | 'busy' | 'interrupted' | 'empty' | 'fewerBacks' | 'fewerFronts';

export function assembleBlockOf(input: {
  /** Идёт запись пакета (KTD-9 M3). */
  readonly saving: boolean;
  /** Правка в полёте: сборка легла бы на незаписанную расстановку. */
  readonly busy: boolean;
  /** Последний проход прерван: сначала досканировать или оставить как есть. */
  readonly interrupted: boolean;
  /** Группы ленты; `null` — не режим наборов, кнопки нет. */
  readonly sets: SetsLayout | null;
}): AssembleBlock | undefined {
  const { sets } = input;
  if (sets === null) {
    return undefined;
  }
  return (
    [
      [input.saving, 'saving'],
      [input.busy, 'busy'],
      [input.interrupted, 'interrupted'],
      [sets.fronts === 0 && sets.backs === 0, 'empty'],
      [sets.backs < sets.fronts, 'fewerBacks'],
      [sets.fronts < sets.backs, 'fewerFronts'],
    ] as const
  ).find(([on]) => on)?.[1];
}

/** Текст причины для `title`: нехватка — с числом недостающих страниц. */
export function assembleBlockText(t: TFunction, block: AssembleBlock, sets: SetsLayout): string {
  if (block === 'fewerBacks' || block === 'fewerFronts') {
    return t(`editor.assembleDisabled.${block}`, { count: Math.abs(sets.fronts - sets.backs) });
  }
  return t(`editor.assembleDisabled.${block}`);
}
