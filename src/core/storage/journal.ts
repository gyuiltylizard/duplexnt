import { z } from 'zod';
import { COLOR_MODES, PAPER_SIZES, type PassState, type ScanParams } from '@shared';
import {
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

export const JOURNAL_VERSION = 1;

export const scanParamsSchema = z.strictObject({
  colorMode: z.enum(COLOR_MODES),
  resolution: z.number().int().min(1).max(9600),
  paperSize: z.enum(PAPER_SIZES),
}) satisfies z.ZodType<ScanParams>;

const segmentSchema = z.strictObject({
  number: z.number().int().min(1).max(MAX_SEGMENT_NUMBER),
  /** «Идёт» пишется до `POST` (KTD-17); найденное при запуске считается прерванным. */
  state: z.enum(['running', 'completed', 'interrupted']),
  pageCount: z.number().int().min(0).max(MAX_PAGE_INDEX),
});

const passSchema = z.strictObject({
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

export const journalSchema = z
  .strictObject({
    version: z.literal(JOURNAL_VERSION),
    sessionId: z.string().regex(SESSION_ID),
    nextPass: z
      .number()
      .int()
      .min(1)
      .max(MAX_PASS_NUMBER + 1),
    passes: z.array(passSchema),
    /** Пометки об удалении — префиксы ключей; файлы под ними страницами не считаются (KTD-20). */
    deletions: z.array(z.string().regex(/^p\d{2}-s\d{2}-$/)),
  })
  .refine(
    (journal) =>
      isOrdered(journal.passes, journal.nextPass) &&
      journal.passes.every((pass) => isOrdered(pass.segments, pass.nextSegment)),
  );

export type Journal = z.infer<typeof journalSchema>;
export type JournalPass = Journal['passes'][number];
export type JournalSegment = JournalPass['segments'][number];
export type PassOrigin = NonNullable<JournalPass['origin']>;

export function parseJournal(bytes: Uint8Array): VersionedParse<Journal> {
  return parseVersioned(bytes, journalSchema, JOURNAL_VERSION);
}

export function newJournal(sessionId: string): Journal {
  return { version: JOURNAL_VERSION, sessionId, nextPass: 1, passes: [], deletions: [] };
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
