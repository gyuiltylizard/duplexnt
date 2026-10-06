import { z } from 'zod';
import { EMPTY_EDITS, MAX_DOCUMENT_NAME_LENGTH, type PassState } from '@shared';
import { scanParamsSchema } from '../escl/scan-settings';
import {
  isPageKey,
  MAX_PAGE_INDEX,
  MAX_PASS_NUMBER,
  MAX_SEGMENT_NUMBER,
  pageKey,
  SESSION_ID,
  type PageAddress,
} from './layout';
import { storedScannerSchema } from './stored-scanner';
import { parseVersioned, type VersionedParse } from './versioned-file';

// Журнал сессии — один JSON-документ, который целиком переписывается атомарно (ADR 0004,
// амендмент). Тип выводится из схемы: журнал живёт в ядре целиком (ADR 0005).
//
// В журнале нет того, что выводится из остального:
// - состояние прохода — это состояние его последнего сегмента и признак «принят как есть»;
// - страницы сегмента — номера с 1 по `pageCount`; ключ и имя файла выводятся из номеров;
// - «страница потеряна» — запись есть, файла нет: это видно по диску, а не по журналу.

export const JOURNAL_VERSION = 3;

const segmentSchema = z.strictObject({
  number: z.number().int().min(1).max(MAX_SEGMENT_NUMBER),
  /** «Идёт» пишется до `POST` (KTD-17); найденное при запуске считается прерванным. */
  state: z.enum(['running', 'completed', 'interrupted']),
  pageCount: z.number().int().min(0).max(MAX_PAGE_INDEX),
});

const passFields = {
  number: z.number().int().min(1).max(MAX_PASS_NUMBER),
  /** Прерванный проход принят как есть: досканировать его больше не предлагается. */
  accepted: z.boolean(),
  /**
   * Сканер, параметры и предел пикселей страницы (KTD-27, KTD-37). `null` — журнал пересобран по
   * именам файлов: параметры неизвестны, досканировать такой проход нельзя.
   */
  origin: z
    .strictObject({
      scanner: storedScannerSchema,
      params: scanParamsSchema,
      pixelLimit: z.number().int().min(1),
    })
    .nullable(),
  /** Счётчик номеров сегментов: номер отброшенного сегмента не переиспользуется (KTD-15). */
  nextSegment: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEGMENT_NUMBER + 1),
  segments: z.array(segmentSchema).min(1),
};

const passSchema = z.strictObject({
  ...passFields,
  /**
   * Повернуть страницы прохода на 180° при показе и в PDF (M2, KTD-2; амендмент ADR 0004).
   * Решение пользователя — одно на проход; осмыслен на проходе оборотов (роль по KTD-4),
   * исходники страниц не меняются.
   */
  rotate180: z.boolean(),
});

// Номера идут по возрастанию и не достают до счётчика.
function isOrdered(items: readonly { readonly number: number }[], next: number): boolean {
  let previous = 0;
  for (const { number } of items) {
    if (number <= previous || number >= next) {
      return false;
    }
    previous = number;
  }
  return true;
}

const journalFields = {
  sessionId: z.string().regex(SESSION_ID),
  nextPass: z
    .number()
    .int()
    .min(1)
    .max(MAX_PASS_NUMBER + 1),
  /** Пометки об удалении — префиксы ключей; файлы под ними страницами не считаются (KTD-20). */
  deletions: z.array(z.string().regex(/^p\d{2}-s\d{2}-$/)),
};

interface CounteredPass {
  readonly number: number;
  readonly nextSegment: number;
  readonly segments: readonly { readonly number: number }[];
}

const countersHold = (journal: {
  readonly nextPass: number;
  readonly passes: readonly CounteredPass[];
}): boolean =>
  isOrdered(journal.passes, journal.nextPass) &&
  journal.passes.every((pass) => isOrdered(pass.segments, pass.nextSegment));

const pageKeySchema = z.string().refine(isPageKey);

const isNonDecreasing = (values: readonly number[]): boolean =>
  values.every((value, index) => index === 0 || value >= (values[index - 1] ?? 0));

/**
 * Ручные правки (M3; ADR 0004, амендмент 2026-10-06) — итоговое состояние, не лог. Ключи без
 * страниц схема пропускает: их отбрасывает нормализация, а не отказ читать журнал.
 */
const editsSchema = z
  .strictObject({
    order: z.array(pageKeySchema).readonly(),
    rotations: z
      .record(pageKeySchema, z.union([z.literal(90), z.literal(180), z.literal(270)]))
      .readonly(),
    deleted: z.array(pageKeySchema).readonly(),
    cuts: z.array(z.number().int().min(0)).readonly(),
    names: z.array(z.string().max(MAX_DOCUMENT_NAME_LENGTH)).readonly(),
  })
  .refine((edits) => edits.names.length === edits.cuts.length + 1 && isNonDecreasing(edits.cuts));

// Журнал версии 2 (M2): без правок редактора. Чтение v2 обязательно, запись — всегда текущей.
const journalV2Fields = {
  ...journalFields,
  passes: z.array(passSchema),
  /** «Обороты не нужны»: односторонний набор, второй проход не предлагается (M2, KTD-6). */
  backsDeclined: z.boolean(),
  /**
   * Набор сохранён в PDF и с тех пор не менялся (M2, R12): снимается любой правкой, влияющей
   * на вывод, — новой страницей, удалением, сменой поворота, правкой редактора.
   */
  saved: z.boolean(),
};

export const journalSchema = z
  .strictObject({
    version: z.literal(JOURNAL_VERSION),
    ...journalV2Fields,
    edits: editsSchema,
  })
  .refine(countersHold);

const journalV2Schema = z
  .strictObject({ version: z.literal(2), ...journalV2Fields })
  .refine(countersHold);

// Журнал версии 1 (M1): без флага поворота, отказа от оборотов и отметки о сохранении.
const journalV1Pass = z.strictObject(passFields);
const journalV1Schema = z
  .strictObject({ version: z.literal(1), ...journalFields, passes: z.array(journalV1Pass) })
  .refine(countersHold);

export type Journal = z.infer<typeof journalSchema>;
export type JournalPass = Journal['passes'][number];
export type JournalSegment = JournalPass['segments'][number];
export type PassOrigin = NonNullable<JournalPass['origin']>;
export type JournalEdits = Journal['edits'];

type JournalV2 = z.infer<typeof journalV2Schema>;

const upgradeToV3 = (journal: JournalV2): Journal => ({
  ...journal,
  version: JOURNAL_VERSION,
  edits: EMPTY_EDITS,
});

const upgradeToV2 = (journal: z.infer<typeof journalV1Schema>): JournalV2 => ({
  ...journal,
  version: 2,
  passes: journal.passes.map((pass) => ({ ...pass, rotate180: false })),
  backsDeclined: false,
  saved: false,
});

/**
 * Разбор журнала: текущая версия, затем прежние цепочкой дефолтов (v1 → v2 → v3).
 * Несовместимость (маркер новее, неизвестное поле) решается по текущей схеме и прежние не
 * пробует: файл с неизвестным полем несовместим при любой версии.
 */
export function parseJournal(bytes: Uint8Array): VersionedParse<Journal> {
  const current = parseVersioned(bytes, journalSchema, JOURNAL_VERSION);
  if (current.kind !== 'unreadable') {
    return current;
  }
  const v2 = parseVersioned(bytes, journalV2Schema, JOURNAL_VERSION);
  if (v2.kind === 'ok') {
    return { kind: 'ok', value: upgradeToV3(v2.value) };
  }
  const v1 = parseVersioned(bytes, journalV1Schema, JOURNAL_VERSION);
  return v1.kind === 'ok' ? { kind: 'ok', value: upgradeToV3(upgradeToV2(v1.value)) } : current;
}

export function newJournal(sessionId: string): Journal {
  return {
    version: JOURNAL_VERSION,
    sessionId,
    nextPass: 1,
    passes: [],
    deletions: [],
    backsDeclined: false,
    saved: false,
    edits: EMPTY_EDITS,
  };
}

export function lastSegmentOf(pass: JournalPass): JournalSegment {
  const segment = pass.segments.at(-1);
  if (segment === undefined) {
    throw new Error('проход без сегментов: схема журнала такого не допускает');
  }
  return segment;
}

export function passStateOf(pass: JournalPass): PassState {
  const { state } = lastSegmentOf(pass);
  return state === 'interrupted' && pass.accepted ? 'accepted' : state;
}

export interface JournalPage extends PageAddress {
  readonly key: string;
  /** Номер в проходе: порядок получения через все сегменты (KTD-16). */
  readonly number: number;
}

/** Страницы прохода по записям журнала — включая потерянные: место сохраняется. */
export function pagesOf(pass: JournalPass): JournalPage[] {
  const pages: JournalPage[] = [];
  for (const segment of pass.segments) {
    for (let index = 1; index <= segment.pageCount; index += 1) {
      const address = { pass: pass.number, segment: segment.number, index };
      pages.push({ ...address, key: pageKey(address), number: pages.length + 1 });
    }
  }
  return pages;
}

/**
 * Уцелевшие проходы — с хотя бы одной записью о странице. Роль прохода выводится из позиции
 * здесь, а не из чётности `pass.number` (M2, KTD-4): номера не переиспользуются, и после
 * «Остановить» повторный запуск оборотов получает номер 3.
 */
export const survivingPassesOf = (journal: Journal): JournalPass[] =>
  journal.passes.filter((pass) => pass.segments.some((segment) => segment.pageCount > 0));

/** Проход в роли оборотов — второй уцелевший; `null` — его нет. */
export const backsPassOf = (journal: Journal): JournalPass | null =>
  survivingPassesOf(journal)[1] ?? null;

export const pageCountOf = (journal: Journal): number =>
  journal.passes.reduce(
    (total, pass) => total + pass.segments.reduce((sum, segment) => sum + segment.pageCount, 0),
    0,
  );

export interface RunningSegment {
  readonly pass: JournalPass;
  readonly segment: JournalSegment;
}

/** Идущий сегмент: он один и всегда последний в последнем проходе. */
export function runningSegmentOf(journal: Journal | null): RunningSegment | null {
  const pass = journal?.passes.at(-1);
  if (pass === undefined) {
    return null;
  }
  const segment = lastSegmentOf(pass);
  return segment.state === 'running' ? { pass, segment } : null;
}

/** Журнал с заменённым последним проходом; `null` убирает проход. */
export function withLastPass(journal: Journal, pass: JournalPass | null): Journal {
  const passes = journal.passes.slice(0, -1);
  return { ...journal, passes: pass === null ? passes : [...passes, pass] };
}

/** Проход с заменённым последним сегментом. */
export function withLastSegment(pass: JournalPass, segment: JournalSegment): JournalPass {
  return { ...pass, segments: [...pass.segments.slice(0, -1), segment] };
}
