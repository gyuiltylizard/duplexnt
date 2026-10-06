import { z } from 'zod';
import { MAX_DOCUMENT_NAME_LENGTH } from '@shared';
import { isPageKey } from './layout';

// Схема правок редактора (M3; ADR 0004, амендмент 2026-10-06) — одна на журнал и на вход команды
// `setEdits`: форма не может разойтись между тем, что принимает мост, и тем, что пишется на диск.
//
// Ключи без страниц схема пропускает: их вычищает нормализация, а не отказ. Совпадающие разрезы
// (пустой документ) — тоже: их схлопывает нормализация.

const pageKeySchema = z.string().refine(isPageKey);

const isNonDecreasing = (values: readonly number[]): boolean =>
  values.every((value, index) => index === 0 || value >= (values[index - 1] ?? 0));

/**
 * `maxItems` — потолок длины каждой коллекции: мост ставит его против мусора на входе, журнал —
 * нет (большая сессия пользователя не должна стать нечитаемой).
 */
export function editsSchemaOf(maxItems = Number.POSITIVE_INFINITY) {
  return z
    .strictObject({
      order: z.array(pageKeySchema).max(maxItems).readonly(),
      rotations: z
        .record(pageKeySchema, z.union([z.literal(90), z.literal(180), z.literal(270)]))
        .refine((rotations) => Object.keys(rotations).length <= maxItems)
        .readonly(),
      deleted: z.array(pageKeySchema).max(maxItems).readonly(),
      cuts: z.array(z.number().int().min(0)).max(maxItems).readonly(),
      names: z.array(z.string().max(MAX_DOCUMENT_NAME_LENGTH)).max(maxItems).readonly(),
    })
    .refine((edits) => edits.names.length === edits.cuts.length + 1 && isNonDecreasing(edits.cuts));
}
