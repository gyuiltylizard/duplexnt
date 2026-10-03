import { z } from 'zod';
import {
  fail,
  ok,
  PROBE_TOKEN_MAX_LENGTH,
  type ConnectScannerRequest,
  type ProbeRequest,
  type Result,
} from '@shared';
import { DEVICE_PATH_MAX_LENGTH } from '../escl/device-path';
import { scanParamsSchema } from '../escl/scan-settings';

// Схемы входа команд моста (ADR 0005; план M1, KTD-39). Строгие и без приведения типов: лишнее
// поле и «почти подходящий» тип — отказ, а не молчаливая починка. Типы запросов объявлены в
// `shared` — он не может импортировать ядро, — а `satisfies` не даёт схеме и типу разойтись.

export const probeRequestSchema = z.strictObject({
  token: z.string().min(1).max(PROBE_TOKEN_MAX_LENGTH),
}) satisfies z.ZodType<ProbeRequest>;

/** Команда без входа: принимается только `undefined`. */
export const noRequestSchema = z.undefined();

const ADDRESS_MAX_LENGTH = 1024;
/** Идентификатор найденного устройства: метка поиска и номер записи (./../discovery/mdns.ts). */
const DISCOVERED_ID = /^[0-9a-f]{8}-\d{1,4}$/;

// Хост здесь — только строка с потолком; имя, IP-литерал и отсутствие userinfo проверяет разбор
// адреса (`parseScannerAddress`), путь — проверка KTD-7. Схема не берёт на себя их правила.
export const connectScannerRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('address'),
    host: z.string().min(1).max(ADDRESS_MAX_LENGTH),
    scheme: z.enum(['https', 'http']).nullable(),
    port: z.number().int().min(1).max(65535).nullable(),
    basePath: z.string().max(DEVICE_PATH_MAX_LENGTH).nullable(),
  }),
  z.strictObject({
    kind: z.literal('discovered'),
    id: z.string().regex(DISCOVERED_ID),
  }),
]) satisfies z.ZodType<ConnectScannerRequest>;

export { scanParamsSchema };

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
