// Выравнивание перекоса подачи в контракте (M6; ADR 0004, амендмент 2026-10-28; план KTD-6,
// KTD-7, KTD-9). Режим — решение приложения о ленте, не параметр устройства: в `ScanParams` не
// входит, выбирается в `setup`, помнится в настройках и замораживается в журнале сессии при
// старте первого прохода. Статус страницы — чистая функция над снимком и фактами ядра, как
// `blankFlagOf`: одно правило на сборку ядра и зеркало renderer'а. Порогов renderer не знает.

import { pageImageUrl, type PageImageView } from './bridge';
import type { SkewCause, SkewOutcome } from './skew';

export const STRAIGHTEN_MODES = ['auto', 'off'] as const;

/** «Выравнивать автоматически» · «Не выравнивать». */
export type StraightenMode = (typeof STRAIGHTEN_MODES)[number];

/** По умолчанию — выравнивать (R13); «Сбросить параметры» возвращает его. */
export const DEFAULT_STRAIGHTEN_MODE: StraightenMode = 'auto';

/**
 * Почему коррекция отложена (R27, KTD-13): места нет — не навсегда, повтор при следующем
 * открытии сессии; сбой коррекции — до конца сессии. Запись очереди, не исход измерения: в
 * кэш оценок не пишется.
 */
export const STRAIGHTEN_DEFERRED_REASONS = ['noSpace', 'failed'] as const;
export type StraightenDeferredReason = (typeof STRAIGHTEN_DEFERRED_REASONS)[number];

/**
 * Что ядро знает о странице помимо снимка сессии (KTD-9): исход измерения (`null` — ещё не
 * измерена), есть ли выправленный файл любой известной версии и каких версий, отложена ли
 * коррекция. Карта по ключу — по образцу `BlankVerdicts`; ключа нет — ни одного факта:
 * страница ждёт.
 */
export interface StraightenFact {
  readonly outcome: SkewOutcome | null;
  /** Почему не измерена — только при `outcome: 'unmeasurable'`. */
  readonly cause: SkewCause | null;
  /** Версия геометрии выправленного файла любой известной версии; `null` — файла нет. */
  readonly version: number | null;
  /** Версия детектора файла (B-19); `0` — запись прежнего формата без поля; `null` — файла нет. */
  readonly detector: number | null;
  /** Файл не текущих версий (геометрии или детектора) — пересчёт идёт или ждёт; ядро сверяет. */
  readonly stale: boolean;
  readonly deferred: StraightenDeferredReason | null;
}

export type StraightenFacts = ReadonlyMap<string, StraightenFact>;

export const NO_STRAIGHTEN_FACTS: StraightenFacts = new Map();

/**
 * Статус страницы ленты (KTD-9; бриф U7, словарь): «выправлена» — показ и файл из выправленного
 * производного; «оригинал оставлен» — откат пользователя; «не померить» — не по чему мерить или
 * коррекция не помогла; «ровная»; «ждёт» — измерение или коррекция идут; «отложена» — мало
 * места или сбой; `null` — не применимо: пустой оборот, потерянная, режим «не выравнивать».
 */
export const STRAIGHTEN_STATUSES = [
  'straightened',
  'kept',
  'unmeasurable',
  'level',
  'pending',
  'deferred',
] as const;

export type StraightenStatus = (typeof STRAIGHTEN_STATUSES)[number] | null;

/**
 * Причина «не выровнено» — текст по ней выбирает интерфейс (handoff U7): у `unmeasurable` —
 * «не по чему мерить» / «наклон строк не сходится» (`SkewCause`) / «не помогло», у
 * `deferred` — «мало места» / «сбой».
 */
export const STRAIGHTEN_REASONS = ['measure', 'shape', 'nohelp', 'disk', 'fail'] as const;
export type StraightenReason = (typeof STRAIGHTEN_REASONS)[number];

/**
 * Пересчёт выправленного файла прежних версий (B-19): `pending` — идёт или ждёт очереди, `disk` /
 * `fail` — отложен (мало места / сбой), прежний вид показан. Признак ядра, не догадка renderer'а.
 */
export const STRAIGHTEN_RECALC = ['pending', 'disk', 'fail'] as const;
export type StraightenRecalc = (typeof STRAIGHTEN_RECALC)[number];

/**
 * Пометка страницы в ленте: статус, причина (только у `unmeasurable` и `deferred`), версии
 * геометрии и детектора выправленного файла (у `straightened` и `kept`) — они входят в адрес
 * картинки (KTD-7), чтобы откат, пересчёт и смена любой версии меняли адрес, — и пересчёт файла
 * прежних версий (`recalc`, только при файле).
 */
export interface StraightenMark {
  readonly status: StraightenStatus;
  readonly reason: StraightenReason | null;
  readonly version: number | null;
  readonly detector: number | null;
  readonly recalc: StraightenRecalc | null;
}

const NO_FILE = { version: null, detector: null, recalc: null } as const;

export const NO_STRAIGHTEN_MARK: StraightenMark = { status: null, reason: null, ...NO_FILE };
const PENDING_MARK: StraightenMark = { status: 'pending', reason: null, ...NO_FILE };

/**
 * Выправленный файл есть: «выправлена», при откате пользователя — «оригинал оставлен»; у файла
 * прежних версий — пересчёт идёт, ждёт или отложен (AE13; B-19).
 */
const withFile = (input: StraightenMarkInput, fact: StraightenFact): StraightenMark => ({
  status: input.keepOriginal ? 'kept' : 'straightened',
  reason: null,
  version: fact.version,
  detector: fact.detector,
  recalc: !fact.stale
    ? null
    : fact.deferred === null
      ? 'pending'
      : fact.deferred === 'noSpace'
        ? 'disk'
        : 'fail',
});

/** Что нужно знать о странице, чтобы поставить статус (KTD-9). */
export interface StraightenMarkInput {
  /** Режим сессии — заморожен в журнале. */
  readonly mode: StraightenMode;
  /** Файла нет: не измеряется и ничего не ждёт. */
  readonly lost: boolean;
  /** Пустой оборот — скрыт или помечен: не измеряется (R6). */
  readonly blank: boolean;
  /** Пользователь вернул оригинал (`edits.keepOriginal`). */
  readonly keepOriginal: boolean;
  /** Факты ядра; `undefined` — ни измерения, ни файла, ни отсрочки. */
  readonly fact: StraightenFact | undefined;
}

/**
 * Статус страницы — одно правило на ядро и зеркало renderer'а (KTD-9): режим «не выравнивать»,
 * потерянная и пустая — `null`; без исхода измерения — «ждёт», если нет и выправленного файла
 * прежней версии; «не по чему мерить» и «не помогла» — «не померить» с причиной; «ровная»;
 * «выправлять» — «выправлена» при файле (откат пользователя — «оригинал оставлен»), иначе
 * «отложена» с причиной или «ждёт».
 */
export function straightenMarkOf(input: StraightenMarkInput): StraightenMark {
  if (input.mode !== 'auto' || input.lost || input.blank) {
    return NO_STRAIGHTEN_MARK;
  }
  const { fact } = input;
  if (fact === undefined) {
    return PENDING_MARK;
  }
  if (fact.outcome === null) {
    // Исхода текущих версий нет, а файл известной версии есть: кэш оценок потерян (AE8) или
    // версия геометрии сменилась (AE13) — прежний выправленный вид показывается и сохраняется,
    // измерение и пересчёт идут фоном: ни «ждёт», ни отказа сохранения (найдено U9).
    return fact.version === null ? PENDING_MARK : withFile(input, fact);
  }
  switch (fact.outcome) {
    case 'unmeasurable':
      return {
        status: 'unmeasurable',
        reason: fact.cause === 'shape' ? 'shape' : 'measure',
        ...NO_FILE,
      };
    case 'notImproved':
      return { status: 'unmeasurable', reason: 'nohelp', ...NO_FILE };
    case 'level':
      return { status: 'level', reason: null, ...NO_FILE };
    case 'willStraighten':
      if (fact.version !== null) {
        return withFile(input, fact);
      }
      if (fact.deferred !== null) {
        return {
          status: 'deferred',
          reason: fact.deferred === 'noSpace' ? 'disk' : 'fail',
          ...NO_FILE,
        };
      }
      return PENDING_MARK;
  }
}

/** Адрес картинки страницы: вид, ключ и версии геометрии и детектора (только у выправленных видов). */
export interface PageImageRef {
  readonly view: PageImageView;
  readonly key: string;
  readonly version: number | null;
  readonly detector: number | null;
}

/**
 * Какой вид картинки показывать (KTD-7) — одно правило на ленту, превью и полосу прохода:
 * выправленный вид только при статусе «выправлена» и известных версиях файла; откат, ожидание,
 * режим «не выравнивать» и страница прохода без статуса — оригинал. Истина для пометки —
 * статус в снимке; сервер при отсутствии файла отдаёт оригинал.
 */
export function pageImageViewOf(
  page: { readonly key: string; readonly straighten?: StraightenMark },
  size: 'page' | 'thumb',
): PageImageRef {
  const mark = page.straighten;
  if (mark?.status === 'straightened' && mark.version !== null && mark.detector !== null) {
    return {
      view: size === 'page' ? 'straight' : 'straight-thumb',
      key: page.key,
      version: mark.version,
      detector: mark.detector,
    };
  }
  return { view: size, key: page.key, version: null, detector: null };
}

/**
 * Сводка по видимой ленте (KTD-9) — для ПРОВЕРКИ, модалки `save`, хвоста `merge`, тостов и
 * гарда записи: счёт по статусам, причины «не выровнено» со счётом; `null` в счёт не входит.
 */
export interface StraightenSummary {
  /** Режим сессии — заморожен в журнале. */
  readonly mode: StraightenMode;
  readonly straightened: number;
  readonly kept: number;
  readonly level: number;
  readonly unmeasurable: number;
  readonly deferred: number;
  /** Измерение или коррекция ещё идут; запись ждёт нуля (отложенные не считаются). */
  readonly pending: number;
  /** Страниц со статусом — все, кроме `null`. */
  readonly total: number;
  readonly reasons: Readonly<Record<StraightenReason, number>>;
}

/** Сводка без страниц — режим «не выравнивать». */
export const NO_STRAIGHTEN: StraightenSummary = {
  mode: 'off',
  straightened: 0,
  kept: 0,
  level: 0,
  unmeasurable: 0,
  deferred: 0,
  pending: 0,
  total: 0,
  reasons: { measure: 0, shape: 0, nohelp: 0, disk: 0, fail: 0 },
};

export function straightenSummaryOf(
  mode: StraightenMode,
  marks: readonly StraightenMark[],
): StraightenSummary {
  const counts = { straightened: 0, kept: 0, level: 0, unmeasurable: 0, deferred: 0, pending: 0 };
  const reasons = { ...NO_STRAIGHTEN.reasons };
  let total = 0;
  for (const mark of marks) {
    if (mark.status === null) {
      continue;
    }
    total += 1;
    counts[mark.status] += 1;
    if (mark.reason !== null) {
      reasons[mark.reason] += 1;
    }
  }
  return { mode, ...counts, total, reasons };
}

/**
 * Ход коррекции по очереди ядра (U12) — для индикатора: сколько страниц ждут коррекции,
 * включая исполняемую, и какая выправляется сейчас. `null` в снимке — сессии нет или режим
 * «не выравнивать». Измерение сюда не входит: его «ждёт» — в сводке.
 */
export interface StraightenProgress {
  readonly queued: number;
  readonly running: string | null;
}

/** Адрес картинки страницы текущей сессии по её статусу — для `<img src>` ленты, превью и полосы прохода. */
export function pageImageSrc(
  sessionId: string,
  page: { readonly key: string; readonly straighten?: StraightenMark },
  size: 'page' | 'thumb',
): string {
  const ref = pageImageViewOf(page, size);
  return pageImageUrl(sessionId, ref.view, ref.key, ref.version, ref.detector);
}
