import { setTimeout as delay } from 'node:timers/promises';
import {
  fail,
  isBacksKind,
  ok,
  type AssembledPage,
  type BlankMode,
  type HintId,
  type DomainError,
  sessionConflict,
  type PassKind,
  type PassProgress,
  type PassReport,
  type Result,
  type ScanParams,
  type SaveDocumentsReport,
  type SaveDocumentsRequest,
  type SavedFile,
  type SaveMode,
  type SessionConflictReason,
  type SessionEdits,
  type StartPassRequest,
  type SetEditsReport,
  type Snapshot,
  type StartupNotice,
} from '@shared';
import type { ConnectedScanner, ConnectorOptions } from '../escl/connect';
import { jobPathFromLocation } from '../escl/device-path';
import {
  closeScanJob,
  runScanJob,
  SCAN_JOB_LIMITS,
  type ScanJobClock,
  type ScanJobEnd,
  type ScanJobLimits,
} from '../escl/scan-job';
import { buildScanSettings } from '../escl/scan-settings';
import { blankRatio, type BlankDetector } from '../detect/blank';
import { findByUuid } from '../discovery/find-by-uuid';
import { inlineImageWorker, type ImageWorker } from '../image/image-worker';
import { parseStatus } from '../escl/status';
import { createTransport, type ScannerTransport } from '../escl/transport';
import { assemblePdf, type PdfPageInput } from '../pdf/assemble';
import { writeBatch } from '../pdf/save-batch';
import { createBlankScores, type BlankScores } from '../storage/blank-scores';
import type { PassOrigin } from '../storage/journal';
import { layoutOf } from '../storage/layout';
import { limiterOf, type Limiter } from '../storage/limiter';
import { stopKeepsPages } from '../storage/pass-policy';
import { openSessionStore } from '../storage/reconcile';
import type { StartUuidSearch } from '../storage/remembered-search';
import type { PageInfo, SessionStore, SessionStoreOptions } from '../storage/session-store';
import { openSettingsStore, type SettingsStore } from '../storage/settings-store';
import { createSkewScores, type SkewScores } from '../storage/skew-scores';
import { sameScanner, storedScannerOf, type StoredScanner } from '../storage/stored-scanner';
import { ioOf, storageFailure } from '../storage/storage-fs';
import { pagePixelLimit } from '../storage/thumbnails';
import { openUnclosedJobs, type UnclosedJobs } from '../storage/unclosed-jobs';
import { assembleSession } from './assembly';
import { blankRefusal, pagesToScore, shownSpansOf } from './blank-flow';
import { createScannerSlot } from './scanner-slot';
import { pagesToMeasure } from './straighten-flow';

/** Задач над производным в main одновременно — на всё: миниатюры, пустота, измерение (KTD-4). */
const DERIVED_CONCURRENCY = 2;

// Служба прохода (план M1, U17): связывает клиент сканера, хранилище сессии, настройки и
// незакрытые задания в один сценарий и выдаёт снимок, из которого интерфейс выводит экран
// (KTD-23). Состояние прохода — по диаграмме плана:
//
//   идёт → завершён        `404` после страниц
//   идёт → прерван         сбой, таймаут, закрытие окна
//   идёт → (нет)           «Остановить» в первом сегменте или ноль страниц
//   прерван → идёт         досканировать остаток — с параметрами и сканером прохода (KTD-27)
//   идёт → прерван         «Остановить» при досканировании: удалён только идущий сегмент
//   прерван → принят       оставить как есть
//
// Старт прохода по шагам: закрыть незакрытые задания этого сканера (KTD-11) → прочитать лоток
// (R9) → записать сегмент «идёт» в журнал (KTD-17) → `POST`. Исход сегмента пишется до `DELETE`:
// обработчик `onEnd` задания переводит его в хранилище, и только потом задание закрывается.
//
// Новый проход (M2, план U3): без сессии — лицевые; поверх завершённого или принятого
// единственного уцелевшего прохода — обороты (роль — позиция среди уцелевших, не чётность
// номера: после «Остановить» повторный запуск получает номер 3 — KTD-4). Прерванный проход —
// только досканирование; при двух уцелевших или отказе от оборотов новый проход не начинается.

export interface PassServiceOptions extends SessionStoreOptions {
  /** Транспорт и его пределы — подмена для тестов, как у подключения. */
  readonly connector?: ConnectorOptions;
  readonly jobLimits?: Partial<ScanJobLimits>;
  readonly clock?: ScanJobClock;
  /** Снимок изменился; `seq` — его номер. */
  readonly onChange?: (seq: number) => void;
  /** Детектор пустых страниц (M4, KTD3); по умолчанию — настоящий на `sharp`. */
  readonly blankDetector?: BlankDetector;
  /** Поиск запомненного сканера по UUID (M5, KTD9); по умолчанию — настоящий, по mDNS. */
  readonly findByUuid?: StartUuidSearch;
  /**
   * Общий лимитер производного (M6, KTD-4): main создаёт один и отдаёт его сюда и миниатюрам;
   * без опции служба создаёт свой (тесты).
   */
  readonly derivedLimiter?: Limiter;
  /** Исполнитель измерения и коррекции (M6, KTD-10); по умолчанию — прямой, в этом потоке. */
  readonly imageWorker?: ImageWorker;
}

export interface PassService {
  snapshot(): Snapshot;
  /** Id текущей сессии без сборки снимка: его спрашивает каждый запрос изображения. */
  sessionId(): string | null;
  /** Проверка запомненного сканера при запуске; исход — в снимке. */
  checkRememberedScanner(signal?: AbortSignal): Promise<void>;
  /** Сканер подключён явным действием пользователя: запоминается, параметры сверяются (KTD-13). */
  useScanner(connected: ConnectedScanner): Promise<Result<void>>;
  setParams(params: ScanParams): Promise<Result<void>>;
  /** Режим пустых оборотов (M4, R1): настройка приложения; принимается и без сканера. */
  setBlankMode(mode: BlankMode): Promise<Result<void>>;
  /** Подсказка показана с привлечением внимания (B-4): в настройки, в снимок. */
  markHintSeen(hint: HintId): Promise<Result<void>>;
  /**
   * Новый проход или досканирование прерванного. Возвращается, когда задание закрыто. Отказ —
   * проход не начался или не оставил ни страницы, ни сессии.
   */
  /**
   * Проход по запросу (M3.5, KTD-5): `null` — лицевые, обороты или досканирование по очереди;
   * намерение `added` — добавленный набор поверх сессии: обходит «обороты не нужны» и «обороты
   * есть», отказывает без сессии (`noSession`), при прерванном последнем проходе
   * (`passInterrupted`) и с якорем не из сессии (`invalidInput`) — всё до сети.
   */
  startPass(request: StartPassRequest): Promise<Result<PassReport>>;
  /** «Остановить». Встаёт за идущей записью страницы; возвращается, когда задание закрыто. */
  stopPass(): Promise<Result<void>>;
  /** «Оставить как есть». */
  acceptPass(): Promise<Result<void>>;
  /** «Обороты не нужны» (M2, KTD-6): durable-отметка, идемпотентно. */
  declineBacks(): Promise<Result<void>>;
  /**
   * «Собрать документ» (M3.6, KTD5): отклоняется, пока пишется PDF (`saving`) и пока идёт
   * проход (`passRunning`); остальные гарды — хранилище. Принятая и отклонённая команда шлёт
   * снимок.
   */
  assemble(): Promise<Result<void>>;
  /**
   * Правки редактора и флаги 180° по проходам оборотов (M3, KTD-3; M4.5, KTD4). Отклоняется,
   * пока пишется PDF (`saving`) и пока идёт проход (`passRunning`) — KTD-9. Принятая команда
   * всегда шлёт снимок; успех возвращает его номер — по нему редактор узнаёт снимок со своим
   * результатом.
   */
  setEdits(
    edits: SessionEdits,
    rotate180: Readonly<Record<number, boolean>>,
  ): Promise<Result<SetEditsReport>>;
  /**
   * «Оставить как есть» для набора «ДN» с несовпавшими оборотами (M4.5, KTD3). Отклоняется,
   * пока пишется PDF (`saving`) и пока идёт проход (`passRunning`); остальные гарды —
   * хранилище. Принятая и отклонённая команда шлёт снимок.
   */
  keepSetBacks(set: number): Promise<Result<void>>;
  /**
   * «Переснять обороты набора» (M4.5, KTD3): отброс прохода оборотов набора — деструктивно, по
   * явному действию; гарды те же, что у `keepSetBacks`. После успеха набор снова ждёт обороты.
   */
  rescanSetBacks(set: number): Promise<Result<void>>;
  /**
   * Пакетное сохранение в папку (M3, U4): документы ленты (или вся лента одним файлом) в PDF по
   * одному, best-effort. «Сохранено» — только когда записаны все файлы пакета и журнал не
   * менялся с первой попытки. `retry` пишет только неудавшиеся прошлого пакета — в его папку.
   */
  saveDocuments(
    folder: string,
    request: SaveDocumentsRequest,
  ): Promise<Result<SaveDocumentsReport>>;
  /** «Новая пачка». */
  closeSession(): Promise<Result<void>>;
  /**
   * Папка последнего пакета, записанного хотя бы частично (M3.5, KTD-9) — для «Открыть папку»;
   * живёт до выхода. `null` — пакета ещё не было.
   */
  lastBatchFolder(): string | null;
  /** Папка сохранения, выбранная в прошлый раз (M3); `null` — не выбирали. */
  rememberedSaveFolder(): string | null;
  /** Запоминает выбранную папку сохранения; отказ записи оставляет её в памяти. */
  rememberSaveFolder(folder: string): Promise<Result<void>>;
  /**
   * Закрытие окна во время прохода (KTD-26): задание обрывается, проход помечается прерванным,
   * `DELETE` уходит в пределах срока. Возвращается не позже срока.
   */
  interrupt(deadlineMs: number): Promise<void>;
  /**
   * Выход из приложения (M6, KTD-12): фоновая работа над производным — измерения перекоса —
   * отменяется и дожидается; окно и проход — `interrupt`.
   */
  shutdown(): Promise<void>;
  /** Страницы текущей сессии — для схемы изображений и миниатюр. */
  pageInfo(key: string): PageInfo | null;
  readPage(key: string): Promise<Result<Uint8Array>>;
}

/** Незавершённый пакет сохранения (M3, U4). */
interface PendingBatch {
  /** Пакет принадлежит сессии: после «Нового сканирования» повторять нечего. */
  readonly sessionId: string;
  readonly mode: SaveMode;
  readonly folder: string;
  readonly documents: number;
  /** Ревизия журнала первой попытки. */
  readonly revision: number;
  /** Записанные — накопительно. */
  readonly written: readonly SavedFile[];
  /** Номера документов, которые ещё предстоит записать. */
  readonly failed: readonly number[];
}

interface Dependencies {
  readonly store: SessionStore;
  readonly settings: SettingsStore;
  readonly unclosedJobs: UnclosedJobs;
  readonly notices: readonly StartupNotice[];
  /** Оценки пустых страниц (M4, KTD3): кэш уже прочитан при открытии. */
  readonly blank: BlankScores;
  /** Оценки перекоса (M6, KTD-11): кэш уже прочитан при открытии. */
  readonly skew: SkewScores;
}

/** Идущий запуск прохода. */
interface Run {
  readonly controller: AbortController;
  readonly resumed: boolean;
  /** Роль прохода — для снимка (`PassProgress.kind`); роль в журнале пишет хранилище. */
  readonly kind: PassKind;
  /** Намерение запуска — в `beginPass`; `null` — проход по очереди. */
  readonly request: StartPassRequest;
  /** Параметры прохода — у досканирования из журнала, не из настройки (KTD-27). */
  readonly params: ScanParams;
  /** Ожидаемое число страниц — у прохода оборотов страницы лицевого (M2, R2). */
  readonly expected: number | null;
  phase: PassProgress['phase'];
  pages: number;
  /** Чем оборван: «Остановить» удаляет сегмент (кроме `stopKeepsPages`), закрытие окна — нет. */
  intent: 'stop' | 'shutdown' | null;
  /** Итог запуска — для «Остановить», которое его дожидается. */
  done: Promise<Result<PassReport>>;
}

/** Отмена оставляет сегмент прерванным: закрытие окна и `stopKeepsPages` (M4.5, приёмка). */
const cancelKeeps = (current: Run, pages: number): boolean =>
  current.intent === 'shutdown' ||
  (current.intent === 'stop' && stopKeepsPages(current.kind, current.resumed, pages));

const conflict = (reason: SessionConflictReason): Result<never> => ({
  ok: false,
  error: sessionConflict(reason),
});

/** Причина обрыва задания — кодом: отказ устройства как есть, отказ приёмника — через хранилище. */
export function interruptionError(end: ScanJobEnd): DomainError | null {
  if (end.kind !== 'interrupted') {
    return null;
  }
  return end.reason.source === 'device' ? end.reason.error : storageFailure(end.reason.error);
}

export function createPassService(
  { store, settings, unclosedJobs, notices, blank, skew }: Dependencies,
  options: PassServiceOptions = {},
): PassService {
  const jobLimits: ScanJobLimits = { ...SCAN_JOB_LIMITS, ...options.jobLimits };
  const connector = options.connector ?? {};
  const newTransport = (profile: ConnectedScanner['profile']): ScannerTransport =>
    (connector.createTransport ?? createTransport)(profile, connector.limits);

  let run: Run | null = null;
  /** Сохранение PDF идёт: второй вызов — конфликт, а не два диалога и две записи в один путь. */
  let saving = false;
  /**
   * Незавершённый пакет (M3, U4): записанное накапливается, повтор пишет только неудавшиеся.
   * Ревизия — первой попытки: правка между попытками делает уже записанные файлы устаревшими,
   * и «сохранено» не ставится.
   */
  let pendingBatch: PendingBatch | null = null;
  let lastBatchFolder: string | null = null;
  let seq = 0;

  const notify = (): void => {
    seq += 1;
    options.onChange?.(seq);
  };
  const scanner = createScannerSlot({
    settings,
    connector,
    search: options.findByUuid ?? findByUuid,
    notify,
    isPassRunning: () => run !== null,
  });

  // Оценка пустых страниц — только страницы прохода оборотов при режиме сессии ≠ «Оставлять»
  // (`pagesToScore`, KTD3, KTD9); приход вердикта — новый снимок. Оценка не бросает (сбой —
  // вердикт «не пусто»), но фоновая цепочка всё равно не остаётся без обработчика: иначе
  // необработанный отказ в main.
  // Измерение перекоса (M6, U5; KTD-4): по ходу прохода, без `await`, с низким приоритетом в
  // общем лимитере — приём следующей страницы его не ждёт. Отмена (`abort`) — не сбой: `ensure`
  // отвечает `false`, снимок не меняется.
  const measureSkew = (key: string): void => {
    skew.ensure(key).then(
      (changed) => {
        if (changed) {
          notify();
        }
      },
      () => undefined,
    );
  };
  const straightens = (): boolean => store.snapshot()?.straighten === 'auto';
  /** Всё, что по снимку подлежит измерению и ещё не измерено: открытие, пометка «не пустая». */
  const measurePending = (): void => {
    for (const page of pagesToMeasure(store.snapshot(), blank.verdicts())) {
      measureSkew(page.key);
    }
  };
  const detectBlank = (key: string): void => {
    blank.ensure(key).then(
      (changed) => {
        if (changed) {
          notify();
          // Оборот с вердиктом «не пусто» измеряется только теперь (R6): пустые не меряются.
          if (straightens() && blank.verdicts().get(key) === false) {
            measureSkew(key);
          }
        }
      },
      () => undefined,
    );
  };
  // Оценку получают обороты любой пачки — основной и добавленного набора (M4.5, KTD6).
  // Команды, меняющие ленту, ждут конца записи PDF и прохода (KTD-9): одно правило на все.
  const busyConflict = (): Result<never> | null =>
    saving ? conflict('saving') : run !== null ? conflict('passRunning') : null;

  const detectsBlank = (kind: PassKind): boolean =>
    isBacksKind(kind) && store.snapshot()?.blankMode !== 'keep';
  // При открытии: страницы оборотов без кэша считаются в фоне, лента до них — с `pending`.
  for (const page of pagesToScore(store.snapshot())) {
    detectBlank(page.key);
  }
  // Страницы без кэша оценки перекоса — тоже в фоне; обороты без вердикта пустоты дождутся его.
  measurePending();
  /** Отброшенные страницы («Остановить», «Новая пачка», пересъём) теряют и вердикты. */
  const pruneScores = (): void => {
    blank.prune();
    skew.prune();
  };

  // Досканировать можно только тот же сканер, что вёл проход (KTD-27).
  function resumeTarget(): Result<PassOrigin> {
    const target = store.resumeTarget();
    const current = scanner.current();
    if (!target.ok || current.kind !== 'ready') {
      return target;
    }
    return sameScanner(target.value.scanner, storedScannerOf(current.connected))
      ? target
      : conflict('otherScanner');
  }

  // Почему сохранять нельзя. Функция, а не выражение: `run` мутирует конкурентно, и после
  // `await` проверку нужно повторить — прямое сравнение TS сузил бы до «всегда null».
  function refusedSave(): Result<never> | null {
    if (run !== null) {
      return conflict('passRunning');
    }
    if (store.incompatible) {
      return fail('storageIncompatible');
    }
    return store.snapshot() === null ? conflict('noSession') : null;
  }

  /** Страницы ленты → PDF; потерянная страница — отказ, а не молча короче (M2, R11). */
  async function buildPdf(pages: readonly AssembledPage[]): Promise<Result<Uint8Array>> {
    const inputs: PdfPageInput[] = [];
    for (const page of pages) {
      const info = store.pageInfo(page.key);
      const bytes = await store.readPage(page.key);
      if (!bytes.ok) {
        return bytes;
      }
      inputs.push({
        bytes: bytes.value,
        angle: page.angle,
        dpi: info?.dpi ?? null,
        pixelLimit: info?.pixelLimit ?? null,
      });
    }
    return assemblePdf(inputs);
  }

  async function writeDocuments(
    folder: string,
    request: SaveDocumentsRequest,
  ): Promise<Result<SaveDocumentsReport>> {
    const refused = refusedSave();
    if (refused !== null) {
      return refused;
    }
    const session = store.snapshot();
    if (session === null) {
      return conflict('noSession');
    }
    const { order, documents, report, blank: blanks } = assembleSession(session, blank.verdicts());
    // Несобранный документ не сохраняется ни одним путём (M3.6, R16; KTD6): лента из двух
    // наборов — ещё не документ.
    if (report.mode === 'sets') {
      return conflict('notAssembled');
    }
    if (order.length === 0) {
      return conflict('nothingToSave');
    }
    // «Один файл» не смотрит на границы (R15): разрезы и имена в журнале остаются. Скрытые
    // пустые обороты в файл не идут (M4, R10): документы режутся по полной ленте, пишутся без них.
    const spans = shownSpansOf(
      request.mode === 'single'
        ? [order]
        : documents.map((doc) => order.slice(doc.start, doc.start + doc.count)),
    );
    if (request.names.length !== spans.length) {
      return fail('invalidInput', { field: 'names', problem: 'count' });
    }
    // Оценки ещё идут или документ из одних скрытых — отказ до записи (M4, KTD4).
    const refusedByBlank = blankRefusal(blanks, spans);
    if (refusedByBlank !== null) {
      return refusedByBlank;
    }

    // Новый пакет забывает прежний незавершённый: повтор относится только к последнему.
    const previous = request.retry ? pendingBatch : null;
    pendingBatch = previous;
    if (
      request.retry &&
      (previous?.sessionId !== session.id ||
        previous.mode !== request.mode ||
        previous.documents !== spans.length)
    ) {
      return conflict('noFailedFiles');
    }
    // Лента менялась после первой попытки: записанные файлы собраны со старой, и дописать к
    // ним неудавшиеся по новой — значит молча получить пакет, где страница в двух файлах или
    // ни в одном. Пакет пишется заново целиком.
    if (previous !== null && previous.revision !== store.revision()) {
      pendingBatch = null;
      return conflict('batchStale');
    }
    const batch: PendingBatch = previous ?? {
      sessionId: session.id,
      mode: request.mode,
      folder,
      documents: spans.length,
      revision: store.revision(),
      written: [],
      failed: spans.map((_pages, index) => index),
    };

    const outcome = await writeBatch(
      batch.folder,
      batch.failed.map((index) => ({
        index,
        name: request.names[index] ?? '',
        build: () => buildPdf(spans[index] ?? []),
      })),
      ioOf(options),
    );
    if (!outcome.ok) {
      return outcome;
    }
    const written = [...batch.written, ...outcome.value.written].sort(
      (left, right) => left.index - right.index,
    );
    const { failed } = outcome.value;
    if (written.length > 0) {
      lastBatchFolder = batch.folder;
    }
    if (failed.length === 0) {
      pendingBatch = null;
      // Отметка — на набор первой попытки: правка между попытками её не получит (R13).
      await store.markSaved(batch.revision);
      notify();
    } else {
      pendingBatch = { ...batch, written, failed: failed.map((file) => file.index) };
    }
    return ok({ folder: batch.folder, written, failed });
  }

  function snapshot(): Snapshot {
    const session = store.snapshot();
    const last = session?.passes.at(-1);
    return {
      seq,
      scanner: scanner.state(),
      session,
      assembly: session === null ? null : assembleSession(session, blank.verdicts()),
      pass:
        run === null
          ? null
          : {
              phase: run.phase,
              resumed: run.resumed,
              kind: run.kind,
              expected: run.expected,
              params: run.params,
              pages: run.pages,
            },
      canResume: run === null && scanner.current().kind === 'ready' && resumeTarget().ok,
      canAccept: run === null && last?.state === 'interrupted',
      storage: { incompatible: store.incompatible, unsaved: store.unsaved() },
      notices,
      blankMode: settings.get().blankMode,
      straightenMode: settings.get().straightenMode,
      seenHints: settings.get().seenHints,
    };
  }

  // Исход сегмента — в хранилище, до `DELETE` (KTD-17). «Завершён» и «прерван» хранилище
  // принимает и при отказе записи журнала; тогда запись повторяется здесь же, пока задание ещё
  // не закрыто. Ноль страниц в новом проходе — не проход (R9): сегмент убирается, сессии нет.
  async function settleSegment(
    end: ScanJobEnd,
    pages: number,
    current: Run,
  ): Promise<DomainError | null> {
    const discard = async (): Promise<DomainError | null> => {
      const discarded = await store.discardSegment();
      return discarded.ok ? null : discarded.error;
    };
    const finish = async (outcome: 'completed' | 'interrupted'): Promise<null> => {
      await store.endSegment(outcome);
      if (store.unsaved()) {
        await store.flush();
      }
      return null;
    };
    switch (end.kind) {
      case 'completed':
        return finish('completed');
      case 'empty':
        return discard();
      case 'canceled':
        return cancelKeeps(current, pages) ? finish('interrupted') : discard();
      case 'interrupted':
        return pages === 0 && !current.resumed ? discard() : finish('interrupted');
    }
  }

  // Незакрытые задания этого сканера закрываются перед `POST` (KTD-11): путь из файла заново
  // проходит проверку KTD-7. Затем читается лоток (R9): пустой — отказ до задания.
  async function prepare(
    transport: ScannerTransport,
    stored: StoredScanner,
    signal: AbortSignal,
  ): Promise<Result<void>> {
    const { basePath } = stored;
    for (const path of unclosedJobs.jobsOf(stored)) {
      // Молчащий сканер держал бы «Остановить» и закрытие окна на каждом задании.
      if (signal.aborted) {
        return fail('canceled');
      }
      const jobPath = jobPathFromLocation(path, basePath);
      if (
        jobPath === null ||
        (await closeScanJob(transport, jobPath, jobLimits.deleteDeadlineMs))
      ) {
        await unclosedJobs.remove(stored, path);
      }
    }
    if (signal.aborted) {
      return fail('canceled');
    }
    const response = await transport.request({
      method: 'GET',
      path: `${basePath}/ScannerStatus`,
      signal,
    });
    if (!response.ok) {
      return response;
    }
    if (response.value.status !== 200) {
      return fail('scannerBadResponse', { reason: 'status', status: response.value.status });
    }
    const status = parseStatus(response.value.body);
    if (!status.ok) {
      return status;
    }
    return status.value.adfState === 'ScannerAdfEmpty' ? fail('scanNoPaper') : ok(undefined);
  }

  async function runPass(
    current: Run,
    connected: ConnectedScanner,
    origin: PassOrigin,
  ): Promise<Result<PassReport>> {
    const stored = origin.scanner;
    const settingsXml = buildScanSettings(origin.params, connected.capabilities);
    if (!settingsXml.ok) {
      return settingsXml;
    }
    const transport = newTransport(connected.profile);
    try {
      const prepared = await prepare(transport, stored, current.controller.signal);
      if (!prepared.ok) {
        // «Остановить» до задания: ни сегмента, ни страниц — останавливать нечего.
        return prepared.error.code === 'canceled' && current.intent === 'stop'
          ? ok({ end: 'stopped', pages: 0, error: null })
          : prepared;
      }
      const begun = current.resumed
        ? await store.resumePass()
        : await store.beginPass(
            origin,
            current.request,
            settings.get().blankMode,
            settings.get().straightenMode,
          );
      if (!begun.ok) {
        return begun;
      }
      notify();

      // Исход, записанный обработчиком задания; `null` — обработчик не вызывался (задание не
      // создано, адрес негоден, отмена до `POST`), и исход переводится по отчёту. Поле объекта,
      // а не переменная: присваивание идёт из обработчика, и сужение типа иначе его не видит.
      const settled: { value: { readonly error: DomainError | null } | null } = { value: null };
      const result = await runScanJob({
        transport,
        basePath: stored.basePath,
        settings: settingsXml.value,
        signal: current.controller.signal,
        limits: jobLimits,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        sink: async ({ body }) => {
          const accepted = await store.acceptPage(body);
          current.pages += 1;
          notify();
          if (detectsBlank(current.kind)) {
            // Оборот сначала получает вердикт пустоты; измерение перекоса — по нему (R6).
            detectBlank(accepted.key);
          } else if (straightens()) {
            measureSkew(accepted.key);
          }
        },
        onPhase: (phase) => {
          // «Остановить» уже нажато: фаза остаётся «останавливаем», пока задание не закрыто.
          if (current.intent !== null) {
            return;
          }
          current.phase = phase;
          notify();
        },
        onJobCreated: async (jobPath) => {
          await unclosedJobs.add(stored, jobPath);
        },
        onEnd: async (end, pages) => {
          settled.value = { error: await settleSegment(end, pages, current) };
        },
      });

      if (!result.ok) {
        // `POST` не прошёл: задания нет, сегмент «идёт» убирается из журнала.
        await store.discardSegment();
        return result;
      }
      const report = result.value;
      const { job } = report;
      if (job !== null && job.path !== null) {
        await (job.closed
          ? unclosedJobs.remove(stored, job.path)
          : unclosedJobs.add(stored, job.path));
      }
      const settleError =
        settled.value === null
          ? await settleSegment(report.end, report.pages, current)
          : settled.value.error;

      const { end } = report;
      if (end.kind === 'completed') {
        return ok({ end: 'completed', pages: report.pages, error: null });
      }
      if (end.kind === 'empty') {
        return fail('scanNoPaper');
      }
      if (end.kind === 'canceled' && current.intent !== 'shutdown') {
        // «Остановить»: сегмент убран — «остановлен»; оставлен (`stopKeepsPages`) или не убран
        // из-за сбоя — прерван, страницы целы.
        return settleError === null && !cancelKeeps(current, report.pages)
          ? ok({ end: 'stopped', pages: 0, error: null })
          : ok({ end: 'interrupted', pages: report.pages, error: settleError });
      }
      const error =
        end.kind === 'canceled' ? { code: 'canceled' as const } : interruptionError(end);
      // Ни страницы, ни сессии не осталось — проход не состоялся.
      return store.snapshot() === null
        ? { ok: false, error: error ?? { code: 'canceled' } }
        : ok({ end: 'interrupted', pages: report.pages, error });
    } finally {
      transport.close();
    }
  }

  async function startPass(request: StartPassRequest): Promise<Result<PassReport>> {
    if (run !== null) {
      return conflict('passRunning');
    }
    // Запись PDF читает страницы сессии по ходу: новый проход поменял бы ленту под ней.
    if (saving) {
      return conflict('saving');
    }
    if (store.incompatible) {
      return fail('storageIncompatible');
    }
    const slot = scanner.current();
    if (slot.kind !== 'ready') {
      return fail('scannerNotConnected');
    }
    const { connected, params } = slot;
    const stored = storedScannerOf(connected);

    // Политика — у хранилища (`planPass`, KTD-5), до сети: что начнётся и с какой ролью.
    // Служба добавляет только своё: досканировать можно лишь на сканере прохода (KTD-27).
    const plan = store.planPass(request);
    if (!plan.ok) {
      return plan;
    }
    let origin: PassOrigin = {
      scanner: stored,
      params,
      pixelLimit: pagePixelLimit(connected.capabilities.adf),
    };
    if (plan.value.resumed) {
      const target = resumeTarget();
      if (!target.ok) {
        return target;
      }
      origin = target.value;
    }

    const current: Run = {
      controller: new AbortController(),
      resumed: plan.value.resumed,
      kind: plan.value.kind,
      request,
      params: origin.params,
      expected: plan.value.expected,
      phase: 'starting',
      pages: 0,
      intent: null,
      done: Promise.resolve(fail('canceled')),
    };
    run = current;
    current.done = runPass(current, connected, origin).finally(() => {
      run = null;
      // «Остановить» и «Новая пачка» по пустому остатку отбросили страницы: их вердикты — тоже.
      pruneScores();
      notify();
    });
    notify();
    const outcome = await current.done;
    if (!outcome.ok && outcome.error.code === 'scannerCertificateChanged') {
      // По адресу другое устройство (KTD-40): новый отпечаток запомнит только повторное подключение.
      scanner.markOtherDevice(stored, outcome.error);
    }
    return outcome;
  }

  return {
    snapshot,

    sessionId: () => store.snapshot()?.id ?? null,

    checkRememberedScanner: (signal) => scanner.check(signal),

    async useScanner(connected) {
      if (run !== null) {
        return conflict('passRunning');
      }
      await scanner.use(connected);
      return ok(undefined);
    },

    setParams: (params) => scanner.setParams(params),

    async setBlankMode(mode) {
      // Не параметр устройства: сканер не нужен, по capabilities не сверяется (KTD1).
      const saved = await settings.setBlankMode(mode);
      notify();
      return saved;
    },

    async markHintSeen(hint) {
      const saved = await settings.markHintSeen(hint);
      notify();
      return saved;
    },

    startPass,

    async stopPass() {
      const current = run;
      if (current === null) {
        return conflict('noRunningPass');
      }
      if (current.intent !== null) {
        return conflict('stopping');
      }
      current.intent = 'stop';
      current.phase = 'stopping';
      current.controller.abort();
      notify();
      const outcome = await current.done;
      return outcome.ok
        ? outcome.value.error === null
          ? ok(undefined)
          : { ok: false, error: outcome.value.error }
        : outcome;
    },

    async acceptPass() {
      if (run !== null) {
        return conflict('passRunning');
      }
      const accepted = await store.acceptPass();
      notify();
      return accepted;
    },

    async declineBacks() {
      if (run !== null) {
        return conflict('passRunning');
      }
      const declined = await store.declineBacks();
      notify();
      return declined;
    },

    async assemble() {
      // Запись PDF читает ленту по снимку: сборка посреди неё сделала бы файл неправдой (KTD-9).
      const busy = busyConflict();
      if (busy !== null) {
        return busy;
      }
      const assembled = await store.assemble();
      notify();
      return assembled;
    },

    async keepSetBacks(set) {
      const busy = busyConflict();
      if (busy !== null) {
        return busy;
      }
      const kept = await store.keepSetBacks(set);
      notify();
      return kept;
    },

    async rescanSetBacks(set) {
      // Отброс прохода меняет ленту: посреди записи PDF и прохода — отказ (KTD-9). Оценки
      // отброшенных страниц уходят вместе с ними.
      const busy = busyConflict();
      if (busy !== null) {
        return busy;
      }
      const rescanned = await store.rescanSetBacks(set);
      pruneScores();
      notify();
      return rescanned;
    },

    async setEdits(edits, rotate180) {
      // Запись PDF читает ленту по снимку: правка посреди неё сделала бы файл и отметку
      // «сохранено» неправдой, а повтор неудавшихся — гонкой с лентой (KTD-9).
      const busy = busyConflict();
      if (busy !== null) {
        return busy;
      }
      const set = await store.setEdits(edits, rotate180);
      notify();
      // «Это не пустая страница» ставит оборот в очередь измерения (R6); остальным правкам
      // измерять нечего — `ensure` у измеренных молчит.
      if (set.ok) {
        measurePending();
      }
      return set.ok ? ok({ seq }) : set;
    },

    async saveDocuments(folder, request) {
      // Одна запись за раз: двойной клик не должен запустить две записи в одну папку — защита
      // живёт в ядре, а не только в блокировке кнопки; правки в это время отклоняются (KTD-9).
      if (saving) {
        return conflict('saving');
      }
      saving = true;
      try {
        return await writeDocuments(folder, request);
      } finally {
        saving = false;
      }
    },

    async closeSession() {
      if (run !== null) {
        return conflict('passRunning');
      }
      // Закрытие посреди записи унесло бы страницы недописанных документов (KTD-9).
      if (saving) {
        return conflict('saving');
      }
      // Идущие измерения отменяет и дожидается само хранилище (`settleDerived`, KTD-12) — до
      // удаления каталога производного.
      const closed = await store.closeSession();
      if (closed.ok) {
        // Незавершённый пакет принадлежал закрытой сессии: повтор не допишет новую в её папку.
        pendingBatch = null;
        pruneScores();
      }
      notify();
      return closed;
    },

    lastBatchFolder: () => lastBatchFolder,
    rememberedSaveFolder: () => settings.get().saveFolder,
    rememberSaveFolder: (folder) => settings.rememberSaveFolder(folder),

    async interrupt(deadlineMs) {
      const current = run;
      if (current === null) {
        return;
      }
      if (current.intent === null) {
        current.intent = 'shutdown';
        current.controller.abort();
      }
      await Promise.race([current.done, delay(deadlineMs)]);
    },

    async shutdown() {
      skew.abort();
      await skew.settle();
    },

    pageInfo: (key) => store.pageInfo(key),
    readPage: (key) => store.readPage(key),
  };
}

/** Сверка при запуске, хранилища и служба над ними — то, что main создаёт один раз. */
export async function openPassService(
  dataRoot: string,
  options: PassServiceOptions = {},
): Promise<PassService> {
  // Фоновую работу над производным хранилище отменяет и дожидается перед удалением каталога
  // (KTD-12); оценки создаются после хранилища, поэтому связь — через позднюю привязку.
  const derived = { settle: (): Promise<void> => Promise.resolve() };
  const { store, notices } = await openSessionStore(dataRoot, {
    ...options,
    settleDerived: () => derived.settle(),
  });
  const settings = await openSettingsStore(dataRoot, options);
  const unclosedJobs = await openUnclosedJobs(dataRoot, options);
  const { derivedDir } = layoutOf(dataRoot);
  // Один лимитер на всё производное main-стороны (KTD-4): main отдаёт его и миниатюрам.
  const limiter = options.derivedLimiter ?? limiterOf(DERIVED_CONCURRENCY);
  // Кэш оценок страниц оборотов читается до первого снимка (KTD3): лента после перезапуска
  // сразу с флагами, без детектора. Режим «Оставлять» оценок не имеет.
  const blank = createBlankScores(derivedDir, store, options.blankDetector ?? blankRatio, {
    ...options,
    limiter,
  });
  await blank.load(pagesToScore(store.snapshot()).map((page) => page.key));
  // Кэш оценок перекоса — так же (KTD-11); обороты без вердикта пустоты измеряются после него.
  const worker = options.imageWorker ?? inlineImageWorker();
  const skew = createSkewScores(
    derivedDir,
    store,
    (bytes, pixelLimit, measure) => worker.measure(bytes, pixelLimit, measure),
    { ...options, limiter },
  );
  derived.settle = async (): Promise<void> => {
    skew.abort();
    await skew.settle();
  };
  await skew.load(pagesToMeasure(store.snapshot(), blank.verdicts()).map((page) => page.key));
  return createPassService(
    {
      store,
      settings,
      unclosedJobs,
      notices: settings.notice === null ? notices : [...notices, settings.notice],
      blank,
      skew,
    },
    options,
  );
}
