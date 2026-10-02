import { z } from 'zod';
import { fail, ok, PROBE_TOKEN_MAX_LENGTH, type ProbeRequest, type Result } from '@shared';

// Схемы входа команд моста (ADR 0005; план M1, KTD-39). Строгие и без приведения типов: лишнее
// поле и «почти подходящий» тип — отказ, а не молчаливая починка. Типы запросов объявлены в
// `shared` — он не может импортировать ядро, — а `satisfies` не даёт схеме и типу разойтись.

export const probeRequestSchema = z.strictObject({
  token: z.string().min(1).max(PROBE_TOKEN_MAX_LENGTH),
}) satisfies z.ZodType<ProbeRequest>;

// Мусор на входе — доменный отказ, а не исключение. В детали идут только путь поля и код
// нарушения: само значение не возвращается, оно может оказаться большим или чужим.
export function parseInput<T>(schema: z.ZodType<T>, rawInput: unknown): Result<T> {
  const parsed = schema.safeParse(rawInput);
  if (parsed.success) {
    return ok(parsed.data);
  }

  const issue = parsed.error.issues[0];
  return fail('invalidInput', {
    field: issue?.path.map(String).join('.') ?? '',
    problem: issue?.code ?? 'custom',
  });
}
