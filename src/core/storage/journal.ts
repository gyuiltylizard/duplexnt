import { z } from 'zod';
import {
  EMPTY_EDITS,
  PASS_KINDS,
  passesByKind,
  type PassesByKind,
  type PassKind,
  type PassState,
} from '@shared';
import { scanParamsSchema } from '../escl/scan-settings';
import { editsSchemaOf, editsV4Schema, pageKeySchema } from './edits-schema';
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
// Запись сборки (`assembled`, M3.6) — не выводимое, а решение пользователя: порядок листов при
// несовпадении проходов из проходов не следует (амендмент 2026-10-19).

export const JOURNAL_VERSION = 5;

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

const passV3Fields = {
  ...passFields,
  /**
   * Повернуть страницы прохода на 180° при показе и в PDF (M2, KTD-2; амендмент ADR 0004).
   * Решение пользователя — одно на проход; осмыслен на проходе оборотов (`kind: 'backs'`),
   * исходники страниц не меняются.
   */
  rotate180: z.boolean(),
};

// Проход версии 4 (M3.5; амендмент ADR 0004 от 2026-10-07): роль записана явно, у добавленного
// набора — якорь вставки. Якорь только у `added`; у основных проходов всегда `null`.
const passSchema = z
  .strictObject({
    ...passV3Fields,
    kind: z.enum(PASS_KINDS),
    after: pageKeySchema.nullable(),
  })
  .refine((pass) => pass.kind === 'added' || pass.after === null);

const passV3Schema = z.strictObject(passV3Fields);

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

interface CountedPass {
  readonly segments: readonly { readonly pageCount: number }[];
}

/** Роль действует только у прохода со страницами (амендмент 2026-10-07). */
const hasPages = (pass: CountedPass): boolean =>
  pass.segments.some((segment) => segment.pageCount > 0);

// Лицевых и оборотов — не больше одного каждого. Считаются только проходы со страницами:
// пустой проход роли не занимает, и после сбоя до первой страницы повторный запуск той же роли
// получает новый номер рядом с пустым (журнал его не выбрасывает).
const rolesHold = (journal: {
  readonly passes: readonly (CountedPass & { readonly kind: PassKind })[];
}): boolean => {
  const counted = journal.passes.filter(hasPages);
  const of = (kind: PassKind): number => counted.filter((pass) => pass.kind === kind).length;
  return of('fronts') <= 1 && of('backs') <= 1;
};

const editsSchema = editsSchemaOf();

/** Ключи записи сборки не повторяются: страница в ленте ровно один раз. */
const assembledUnique = (journal: { readonly assembled: readonly string[] | null }): boolean =>
  journal.assembled === null || new Set(journal.assembled).size === journal.assembled.length;

// Журнал версии 2 (M2): без правок редактора. Чтение прежних версий обязательно, запись —
// всегда текущей.
const journalV2Fields = {
  ...journalFields,
  passes: z.array(passV3Schema),
  /** «Обороты не нужны»: односторонний набор, второй проход не предлагается (M2, KTD-6). */
  backsDeclined: z.boolean(),
  /**
   * Набор сохранён в PDF и с тех пор не менялся (M2, R12): снимается любой правкой, влияющей
   * на вывод, — новой страницей, удалением, сменой поворота, правкой редактора.
   */
  saved: z.boolean(),
};

// Журнал версии 3 (M3): правки редактора, роль прохода — по позиции.
const journalV3Fields = { ...journalV2Fields, edits: editsV4Schema };

// Журнал версии 4 (M3.5): роль прохода и якорь записаны явно.
const journalV4Fields = { ...journalV3Fields, passes: z.array(passSchema) };

// Журнал версии 5 (M3.6; амендмент ADR 0004 от 2026-10-19): запись сборки на сессии и граница
// наборов в правках. `assembled` — зафиксированная командой «Собрать документ» последовательность
// ключей (в том числе удалённых на момент сборки) или `null` («не собрано»); мёртвые ключи из
// неё вычищает нормализация, а не схема.
export const journalSchema = z
  .strictObject({
    version: z.literal(JOURNAL_VERSION),
    ...journalV4Fields,
    edits: editsSchema,
    assembled: z.array(pageKeySchema).readonly().nullable(),
  })
  .refine(countersHold)
  .refine(rolesHold)
  .refine(assembledUnique);

const journalV4Schema = z
  .strictObject({ version: z.literal(4), ...journalV4Fields })
  .refine(countersHold)
  .refine(rolesHold);

const journalV3Schema = z
  .strictObject({ version: z.literal(3), ...journalV3Fields })
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

type JournalV2 = z.infer<typeof journalV2Schema>;
type JournalV3 = z.infer<typeof journalV3Schema>;
type JournalV4 = z.infer<typeof journalV4Schema>;

/** Чтение v4: не собрано, граница наборов авто (M3.6, R1). */
const upgradeToV5 = (journal: JournalV4): Journal => ({
  ...journal,
  version: JOURNAL_VERSION,
  edits: { ...journal.edits, divider: null },
  assembled: null,
});

/**
 * Роль по позиции (чтение v3): первый проход со страницами — лицевые, второй — обороты,
 * остальные — добавленные. Пустой проход получает роль, которую занял бы следующий со
 * страницами: роли у него всё равно нет, а схема считает только проходы со страницами.
 */
const upgradeToV4 = (journal: JournalV3): JournalV4 => {
  let rank = 0;
  const passes = journal.passes.map((pass) => {
    const kind: PassKind = (['fronts', 'backs'] as const)[rank] ?? 'added';
    if (hasPages(pass)) {
      rank += 1;
    }
    return { ...pass, kind, after: null };
  });
  return { ...journal, version: 4, passes };
};

const upgradeToV3 = (journal: JournalV2): JournalV3 => ({
  ...journal,
  version: 3,
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
 * Разбор журнала: текущая версия, затем прежние цепочкой дефолтов (v1 → v2 → v3 → v4 → v5).
 * Несовместимость (маркер новее, неизвестное поле) решается по текущей схеме и прежние не
 * пробует: файл с неизвестным полем несовместим при любой версии.
 */
export function parseJournal(bytes: Uint8Array): VersionedParse<Journal> {
  const current = parseVersioned(bytes, journalSchema, JOURNAL_VERSION);
  if (current.kind !== 'unreadable') {
    return current;
  }
  const v4 = parseVersioned(bytes, journalV4Schema, JOURNAL_VERSION);
  if (v4.kind === 'ok') {
    return { kind: 'ok', value: upgradeToV5(v4.value) };
  }
  const v3 = parseVersioned(bytes, journalV3Schema, JOURNAL_VERSION);
  if (v3.kind === 'ok') {
    return { kind: 'ok', value: upgradeToV5(upgradeToV4(v3.value)) };
  }
  const v2 = parseVersioned(bytes, journalV2Schema, JOURNAL_VERSION);
  if (v2.kind === 'ok') {
    return { kind: 'ok', value: upgradeToV5(upgradeToV4(upgradeToV3(v2.value))) };
  }
  const v1 = parseVersioned(bytes, journalV1Schema, JOURNAL_VERSION);
  return v1.kind === 'ok'
    ? { kind: 'ok', value: upgradeToV5(upgradeToV4(upgradeToV3(upgradeToV2(v1.value)))) }
    : current;
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
    assembled: null,
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

/** Проходы журнала по ролям (`passesByKind` из shared над записями журнала). */
export const rolesOf = (journal: Journal): PassesByKind<JournalPass> =>
  passesByKind(journal.passes, hasPages);

/**
 * Роль следующего прохода без явного намерения — для нового прохода и для усыновлённых сверкой
 * (амендмент 2026-10-07): лицевые, пока их нет; обороты, пока их нет и от них не отказались;
 * иначе — добавленный набор без якоря.
 */
export function nextKindOf(journal: Journal): PassKind {
  const { fronts, backs } = rolesOf(journal);
  if (fronts === null) {
    return 'fronts';
  }
  return backs === null && !journal.backsDeclined ? 'backs' : 'added';
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
