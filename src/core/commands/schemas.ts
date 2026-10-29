import { z } from 'zod';
import {
  BLANK_MODES,
  HINTS,
  fail,
  MAX_DOCUMENT_NAME_LENGTH,
  ok,
  PROBE_TOKEN_MAX_LENGTH,
  SAVE_MODES,
  STRAIGHTEN_MODES,
  type BlankMode,
  type HintId,
  type ConnectScannerRequest,
  type ProbeRequest,
  type Result,
  type SaveDocumentsRequest,
  type SetDecisionRequest,
  type SetEditsRequest,
  type StartPassRequest,
  type StraightenMode,
} from '@shared';
import { DEVICE_PATH_MAX_LENGTH } from '../escl/device-path';
import { scanParamsSchema } from '../escl/scan-settings';
import { editsSchemaOf, pageKeySchema } from '../storage/edits-schema';
import { MAX_PASS_NUMBER } from '../storage/layout';

// Схемы входа команд моста (ADR 0005; план M1, KTD-39). Строгие и без приведения типов: лишнее
// поле и «почти подходящий» тип — отказ, а не молчаливая починка. Типы запросов объявлены в
// `shared` — он не может импортировать ядро, — а `satisfies` не даёт схеме и типу разойтись.

export const probeRequestSchema = z.strictObject({
  token: z.string().min(1).max(PROBE_TOKEN_MAX_LENGTH),
}) satisfies z.ZodType<ProbeRequest>;

/** Команда без входа: принимается только `undefined`. */
export const noRequestSchema = z.undefined();

/**
 * Запуск прохода (M3.5, KTD-5; M4.5, R4): `null` — проход по очереди; намерение добавленного
 * набора — одностороннего или лиц двустороннего — с якорем ключом страницы или `null`.
 * Принадлежность якоря сессии проверяет служба (R9).
 */
export const startPassRequestSchema = z
  .strictObject({
    kind: z.enum(['added', 'addedFronts']),
    after: pageKeySchema.nullable(),
  })
  .nullable() satisfies z.ZodType<StartPassRequest>;

/** Номер прохода или набора «ДN» в запросе: целое в пределах счётчика проходов. */
const PASS_NUMBER_KEY = /^[1-9]\d{0,3}$/;

/** Решение по оборотам набора «ДN» (M4.5, KTD3): сам номер проверяет ядро (`noPendingSet`). */
export const setDecisionRequestSchema = z.strictObject({
  set: z.number().int().min(1).max(MAX_PASS_NUMBER),
}) satisfies z.ZodType<SetDecisionRequest>;

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

/**
 * Потолок коллекций правок на входе: на порядки больше реальной сессии (сотни страниц), но
 * мусорный массив на миллионы элементов до ядра не доходит.
 */
export const MAX_EDIT_ITEMS = 10_000;

/**
 * Флаги 180° по проходам оборотов (M4.5, KTD4): ключи — номера проходов (JSON несёт их
 * строками), значения — флаги; роль прохода проверяет хранилище (`noBacksPass`).
 */
const rotate180Schema = z
  .record(z.string().regex(PASS_NUMBER_KEY), z.boolean())
  .refine(
    (flags) =>
      Object.keys(flags).length <= MAX_EDIT_ITEMS &&
      Object.keys(flags).every((key) => Number(key) <= MAX_PASS_NUMBER),
  );

export const setEditsRequestSchema = z.strictObject({
  edits: editsSchemaOf(MAX_EDIT_ITEMS),
  rotate180: rotate180Schema,
}) satisfies z.ZodType<SetEditsRequest>;

/**
 * Пакетное сохранение: имена файлов по документам. Имя проверяется только на длину — правила
 * NTFS применяет ядро при записи (KTD-11), чтобы не отказывать человеку из-за «:» в имени.
 */
export const saveDocumentsRequestSchema = z.strictObject({
  mode: z.enum(SAVE_MODES),
  names: z.array(z.string().max(MAX_DOCUMENT_NAME_LENGTH)).min(1).max(MAX_EDIT_ITEMS).readonly(),
  retry: z.boolean(),
}) satisfies z.ZodType<SaveDocumentsRequest>;

export { scanParamsSchema };

/** Режим пустых оборотов (M4, R1): одно из трёх значений словаря, без приведения типов. */
export const blankModeSchema = z.enum(BLANK_MODES) satisfies z.ZodType<BlankMode>;

/** Режим выравнивания перекоса (M6, R13): одно из двух значений словаря, без приведения типов. */
export const straightenModeSchema = z.enum(STRAIGHTEN_MODES) satisfies z.ZodType<StraightenMode>;

export const hintIdSchema = z.enum(HINTS) satisfies z.ZodType<HintId>;

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
