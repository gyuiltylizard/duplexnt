import { createHash } from 'node:crypto';
import {
  isBacksKind,
  NO_STRAIGHTEN_FACTS,
  sessionConflict,
  STRAIGHTEN_GEOMETRY_VERSION,
  type AssembledPage,
  type BlankVerdicts,
  type PageSnapshot,
  type Result,
  type SessionSnapshot,
  type SkewProfile,
  type SkewVerdicts,
  type StraightenDeferredReason,
  type StraightenFact,
  type StraightenFacts,
  type StraightenProgress,
  type StraightenSummary,
} from '@shared';
import type { ImageWorker } from '../image/image-worker';
import { STRAIGHT_SIZE_RATIO } from '../image/straighten';
import { isAlive, pruneStale } from '../storage/liveness';
import type { PageInfo } from '../storage/session-store';
import type { SkewScores } from '../storage/skew-scores';
import { storageFailure } from '../storage/storage-fs';
import {
  isCurrentStraightened,
  type Straightened,
  type StraightenedFile,
} from '../storage/straightened';
import type { ThumbnailSource } from '../storage/thumbnails';

// Выравнивание перекоса в службе проходов (план M6, U5, U11, U12; R6, R27; KTD-4, KTD-8,
// KTD-9, KTD-12, KTD-13): какие страницы получают измерение, очередь коррекции, факты для
// статусов в снимке, гард записи и снимок выправленных на сохранение. `pagesToMeasure`,
// `straightenFactsOf`, `straightenRefusal`, `straightSnapshotOf` — чистые функции; очередь —
// одна задача за раз, принимает только страницы с исходом «выправлять», работает и во время
// прохода (замер A/B U1: подача от нагрузки хоста не зависит — пауза KTD-4 снята), проверяет
// место до коррекции, живость страницы до и после записи; любой сбой, кроме отмены, —
// `deferred` с причиной, очередь идёт дальше. Отмена оставляет страницы без записи: они ждут
// следующего `ensureAll` (открытие сессии), и сохранение честно отказывает.

/**
 * Страницы, которые измеряются (R6): все проходы сессии в режиме «выравнивать», только не
 * потерянные; у оборотов при режиме пустых ≠ «Оставлять» — только с вердиктом «не пусто» или с
 * пометкой «Это не пустая страница» (решение пользователя важнее оценки). Оборот без вердикта
 * ещё не измеряется — измерение запускает приход вердикта. В режиме «не выравнивать» — никто.
 */
export function pagesToMeasure(
  session: SessionSnapshot | null,
  blank: BlankVerdicts,
): readonly PageSnapshot[] {
  if (session?.straighten !== 'auto') {
    return [];
  }
  const notBlank = new Set(session.edits.notBlank);
  const scored = session.blankMode !== 'keep';
  return session.passes.flatMap((pass) =>
    pass.pages.filter((page) => {
      if (page.lost) {
        return false;
      }
      if (!scored || !isBacksKind(pass.kind) || notBlank.has(page.key)) {
        return true;
      }
      return blank.get(page.key) === false;
    }),
  );
}

/**
 * Факты ядра для статусов страниц (KTD-9): исход измерения, запись о коррекции любой известной
 * версии (`resolve`) с её версиями и признаком «не текущая» (B-19), отсрочка из очереди. Только в
 * режиме «выравнивать» и только у страниц, о которых хоть что-то известно: остальные ждут. Снимок
 * строится на каждом `snapshot()`, поэтому без аллокаций сверх нужного.
 */
export function straightenFactsOf(
  session: SessionSnapshot | null,
  verdicts: SkewVerdicts,
  straightened: Pick<Straightened, 'resolve'>,
  queue: StraightenQueueState,
): StraightenFacts {
  if (session?.straighten !== 'auto') {
    return NO_STRAIGHTEN_FACTS;
  }
  const facts = new Map<string, StraightenFact>();
  for (const pass of session.passes) {
    for (const page of pass.pages) {
      const verdict = verdicts.get(page.key);
      const outcome = verdict?.outcome ?? null;
      const file = straightened.resolve(page.key);
      const deferred = queue.deferred.get(page.key) ?? null;
      if (outcome !== null || file !== null || deferred !== null) {
        facts.set(page.key, {
          outcome,
          cause: verdict?.cause ?? null,
          version: file?.version ?? null,
          detector: file?.detector ?? null,
          stale: file !== null && !isCurrentStraightened(file),
          deferred,
        });
      }
    }
  }
  return facts;
}

/** Ход коррекции для снимка: `null` вне режима «выравнивать». */
export function straightenProgressOf(
  session: SessionSnapshot | null,
  queue: StraightenQueueState,
): StraightenProgress | null {
  return session?.straighten === 'auto'
    ? { queued: queue.queued.length, running: queue.running }
    : null;
}

/**
 * Отказ записи по выравниванию (KTD-8, R19), после отказов по пустым оборотам: измерение или
 * коррекция ещё идут — `straightenPending` с числом (файл без них молча унёс бы оригинал
 * вместо выправленной). Отложенные страницы не блокируют (AE15): уходят оригиналом.
 */
export function straightenRefusal(summary: StraightenSummary): Result<never> | null {
  return summary.pending > 0
    ? { ok: false, error: sessionConflict('straightenPending', { pending: summary.pending }) }
    : null;
}

/** Выправленный файл страницы на момент начала пакета (KTD-8). */
export type StraightSnapshot = ReadonlyMap<string, StraightenedFile>;

/**
 * Снимок выправленных страниц пакета и его дайджест (KTD-8): по статусу `straightened` — у
 * него запись о коррекции есть по построению; откаченные и невыправленные читаются из
 * исходников. Дайджест — по ключам, версиям и размерам: поздняя коррекция другой страницы или
 * смена файла между попытками меняет его, и повтор пакета отказывает «данные изменились» (AE14).
 */
export function straightSnapshotOf(
  pages: readonly AssembledPage[],
  straightened: Pick<Straightened, 'resolve'>,
): { readonly snapshot: StraightSnapshot; readonly digest: string } {
  const snapshot = new Map<string, StraightenedFile>();
  for (const page of pages) {
    if (page.straighten.status !== 'straightened') {
      continue;
    }
    const file = straightened.resolve(page.key);
    if (file !== null) {
      snapshot.set(page.key, file);
    }
  }
  const hash = createHash('sha256');
  for (const key of [...snapshot.keys()].sort()) {
    const file = snapshot.get(key);
    hash.update(`${key}\n${String(file?.version)}\n${String(file?.bytes)}\n`);
  }
  return { snapshot, digest: hash.digest('hex') };
}

export interface StraightenQueueState {
  /** Ключи в очереди, включая исполняемую. */
  readonly queued: readonly string[];
  readonly running: string | null;
  readonly deferred: ReadonlyMap<string, StraightenDeferredReason>;
}

export interface StraightenQueueDeps {
  readonly source: ThumbnailSource;
  readonly skew: Pick<SkewScores, 'verdicts'>;
  readonly straightened: Straightened;
  readonly worker: Pick<ImageWorker, 'straighten'>;
  /** Свободное место на томе данных; исключение — места не знаем, коррекция идёт. */
  readonly freeBytes: () => Promise<number>;
  /** Резерв — тот же, что перед проходом (KTD-13). */
  readonly minFreeBytes: number;
  /** Исход записан или страница отложена — новый снимок. */
  readonly onChange: () => void;
}

export interface StraightenQueue {
  /**
   * Ставит страницу в очередь, если ей это нужно: исход «выправлять» с профилем, записи
   * текущей версии нет, не отложена, не в очереди. Остальное — молча ничего.
   */
  enqueue(key: string): void;
  /** Все страницы с вердиктом — через `enqueue`: открытие сессии, смена версии геометрии. */
  ensureAll(): void;
  state(): StraightenQueueState;
  /** Отменяет текущую задачу и очищает очередь (KTD-12); следующие `enqueue` работают. */
  abort(): void;
  /** Ждёт конца текущей задачи — отменённой или нет. */
  settle(): Promise<void>;
  /** Забывает очередь и отложенные страницы, которых у источника больше нет. */
  prune(): void;
}

interface Deferred {
  readonly sessionId: string;
  readonly reason: StraightenDeferredReason;
}

export function createStraightenQueue(deps: StraightenQueueDeps): StraightenQueue {
  const { source, skew, straightened, worker } = deps;
  const queue: string[] = [];
  const deferred = new Map<string, Deferred>();
  let running: Promise<void> | null = null;
  let current: string | null = null;
  let controller = new AbortController();

  const alive = (key: string, info: PageInfo): boolean => isAlive(source, key, info);

  /** Страница и её профиль, если коррекция ей нужна; иначе `null`. */
  const needs = (
    key: string,
  ): { readonly info: PageInfo; readonly profile: SkewProfile } | null => {
    const info = source.pageInfo(key);
    const verdict = skew.verdicts().get(key);
    if (
      info === null ||
      verdict?.outcome !== 'willStraighten' ||
      verdict.profile === null ||
      straightened.resolve(key)?.version === STRAIGHTEN_GEOMETRY_VERSION ||
      deferred.get(key)?.sessionId === info.sessionId
    ) {
      return null;
    }
    return { info, profile: verdict.profile };
  };

  const defer = (key: string, info: PageInfo, reason: StraightenDeferredReason): void => {
    deferred.set(key, { sessionId: info.sessionId, reason });
    deps.onChange();
  };

  /** Хватит ли места на выход коррекции сверх резерва; не узнали — считаем, что хватит. */
  async function hasSpaceFor(bytes: number): Promise<boolean> {
    try {
      return (await deps.freeBytes()) - bytes * STRAIGHT_SIZE_RATIO >= deps.minFreeBytes;
    } catch {
      return true;
    }
  }

  async function process(key: string, signal: AbortSignal): Promise<void> {
    const needed = needs(key);
    if (needed === null) {
      return;
    }
    const { info, profile } = needed;
    const page = await source.readPage(key);
    if (!page.ok) {
      // Потерю отсеивает `needs`; сбой чтения — не навсегда, но и не повтор в этой сессии.
      // Отказ по закрытию сессии — не сбой страницы: закрытие могло не состояться, страница
      // ждёт следующего `ensureAll` (ревью сессий 3–4).
      if (page.error.details?.reason !== 'closing') {
        defer(key, info, 'failed');
      }
      return;
    }
    if (!(await hasSpaceFor(page.value.byteLength))) {
      defer(key, info, 'noSpace');
      return;
    }
    signal.throwIfAborted();
    let result;
    try {
      result = await worker.straighten(page.value, profile, {
        pixelLimit: info.pixelLimit,
        dpi: info.dpi,
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      result = null;
    }
    if (result === null) {
      defer(key, info, 'failed');
      return;
    }
    signal.throwIfAborted();
    if (!alive(key, info)) {
      return;
    }
    try {
      await straightened.store(key, result);
    } catch (error) {
      // `ENOSPC` при записи: временный файл уже убран, страница отложена до места (AE15).
      defer(key, info, storageFailure(error).code === 'storageFull' ? 'noSpace' : 'failed');
      return;
    }
    deps.onChange();
  }

  async function drain(signal: AbortSignal): Promise<void> {
    // Через функцию: отмена приходит между `await`, а сужение типа этого не видит.
    const aborted = (): boolean => signal.aborted;
    while (!aborted()) {
      const key = queue.shift();
      if (key === undefined) {
        return;
      }
      current = key;
      try {
        await process(key, signal);
      } catch {
        // Отмена — выход; иной сбой задачи не роняет очередь.
        if (aborted()) {
          return;
        }
      } finally {
        current = null;
      }
    }
  }

  function kick(): void {
    if (running !== null) {
      return;
    }
    running = drain(controller.signal).finally(() => {
      running = null;
      // Поставленное в очередь, пока прежний прогон доходил после отмены, не ждёт вечно.
      if (queue.length > 0) {
        kick();
      }
    });
  }

  const enqueue = (key: string): void => {
    if (needs(key) === null || queue.includes(key) || current === key) {
      return;
    }
    queue.push(key);
    kick();
  };

  return {
    enqueue,

    ensureAll() {
      for (const key of skew.verdicts().keys()) {
        enqueue(key);
      }
    },

    state: () => ({
      queued: current === null ? [...queue] : [current, ...queue],
      running: current,
      deferred: new Map([...deferred].map(([key, entry]) => [key, entry.reason])),
    }),

    abort() {
      queue.length = 0;
      controller.abort(new Error('коррекция отменена'));
      controller = new AbortController();
    },

    async settle() {
      await running?.catch(() => undefined);
    },

    prune() {
      pruneStale(deferred, source);
      queue.splice(0, queue.length, ...queue.filter((key) => source.pageInfo(key) !== null));
    },
  };
}
