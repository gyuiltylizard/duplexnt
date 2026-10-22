import { z } from 'zod';
import { EDIT_ANGLES, MAX_DOCUMENT_NAME_LENGTH } from '@shared';
import { isPageKey } from './layout';

// Схема правок редактора (M3; ADR 0004, амендмент 2026-10-06) — одна на журнал и на вход команды
// `setEdits`: форма не может разойтись между тем, что принимает мост, и тем, что пишется на диск.
//
// Ключи без страниц схема пропускает: их вычищает нормализация, а не отказ. Совпадающие разрезы
// (пустой документ) — тоже: их схлопывает нормализация.

/** Ключ страницы — одна схема на правки, журнал и вход команд. */
export const pageKeySchema = z.string().refine(isPageKey);

const isNonDecreasing = (values: readonly number[]): boolean =>
  values.every((value, index) => index === 0 || value >= (values[index - 1] ?? 0));

/**
 * Поля правок версии 4 (M3–M3.5). `maxItems` — потолок длины каждой коллекции: мост ставит его
 * против мусора на входе, журнал — нет (большая сессия пользователя не должна стать нечитаемой).
 */
const editsV4FieldsOf = (maxItems: number) => ({
  order: z.array(pageKeySchema).max(maxItems).readonly(),
  rotations: z
    .record(pageKeySchema, z.literal(EDIT_ANGLES))
    .refine((rotations) => Object.keys(rotations).length <= maxItems)
    .readonly(),
  deleted: z.array(pageKeySchema).max(maxItems).readonly(),
  cuts: z.array(z.number().int().min(0)).max(maxItems).readonly(),
  names: z.array(z.string().max(MAX_DOCUMENT_NAME_LENGTH)).max(maxItems).readonly(),
});

const namesMatchCuts = (edits: {
  readonly cuts: readonly number[];
  readonly names: readonly string[];
}): boolean => edits.names.length === edits.cuts.length + 1 && isNonDecreasing(edits.cuts);

/** Правки журнала версии 4: без границы наборов — только для чтения прежних файлов. */
export const editsV4Schema = z
  .strictObject(editsV4FieldsOf(Number.POSITIVE_INFINITY))
  .refine(namesMatchCuts);

/**
 * Поля правок версии 5 (M3.6; амендмент 2026-10-19): к полям v4 — граница наборов `divider`,
 * целое от нуля или `null` (авто). Ноль и значение за концом ленты схема пропускает: границу
 * прижимает и обнуляет вне режима нормализация, как разрезы.
 */
const editsV5FieldsOf = (maxItems: number) => ({
  ...editsV4FieldsOf(maxItems),
  divider: z.number().int().min(0).nullable(),
});

/** Правки журнала версии 5: без пометок «не пустая» — только для чтения прежних файлов. */
export const editsV5Schema = z
  .strictObject(editsV5FieldsOf(Number.POSITIVE_INFINITY))
  .refine(namesMatchCuts);

/**
 * Текущая форма правок (M4; амендмент 2026-10-22): к полям v5 — `notBlank`, ключи страниц,
 * принятых пользователем непустыми. Повторы и мёртвые ключи схема пропускает: их вычищает
 * нормализация.
 */
export function editsSchemaOf(maxItems = Number.POSITIVE_INFINITY) {
  return z
    .strictObject({
      ...editsV5FieldsOf(maxItems),
      notBlank: z.array(pageKeySchema).max(maxItems).readonly(),
    })
    .refine(namesMatchCuts);
}
