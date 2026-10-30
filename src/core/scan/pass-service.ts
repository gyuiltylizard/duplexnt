import { setTimeout as delay } from 'node:timers/promises';
import {
  fail,
  isBacksKind,
  ok,
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
  type SessionAssembly,
  type SessionConflictReason,
  type SessionEdits,
  type SessionSnapshot,
  type StartPassRequest,
  type SetEditsReport,
  type Snapshot,
  type StartupNotice,
  type StraightenMode,
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
import { createBlankScores, type BlankScores } from '../storage/blank-scores';
import type { PassOrigin } from '../storage/journal';
import { layoutOf } from '../storage/layout';
import { limiterOf, type Limiter } from '../storage/limiter';
import { stopKeepsPages } from '../storage/pass-policy';
import { openSessionStore } from '../storage/reconcile';
import type { StartUuidSearch } from '../storage/remembered-search';
import {
  MIN_FREE_BYTES,
  type PageInfo,
  type SessionStore,
  type SessionStoreOptions,
} from '../storage/session-store';
import { openSettingsStore, type SettingsStore } from '../storage/settings-store';
import { createSkewScores, type SkewScores } from '../storage/skew-scores';
import { sameScanner, storedScannerOf, type StoredScanner } from '../storage/stored-scanner';
import { ioOf, storageFailure } from '../storage/storage-fs';
import { createStraightened, type Straightened } from '../storage/straightened';
import { pagePixelLimit } from '../storage/thumbnails';
import { openUnclosedJobs, type UnclosedJobs } from '../storage/unclosed-jobs';
import { assembleSession } from './assembly';
import { pagesToScore } from './blank-flow';
import { createDocumentWriter } from './save-flow';
import { createScannerSlot } from './scanner-slot';
import {
  createStraightenQueue,
  pagesToMeasure,
  straightenFactsOf,
  straightenProgressOf,
  type StraightenQueue,
  type StraightenQueueState,
} from './straighten-flow';

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
  /** Режим выравнивания (M6, R13, R14): настройка приложения; открытую сессию не трогает. */
  setStraightenMode(mode: StraightenMode): Promise<Result<void>>;
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
   * одному, best-effort. «Сохранено» — только когда записаны все файлы пакета, журнал и
   * выправленные страницы не менялись с первой попытки (KTD-8). `retry` пишет только
   * неудавшиеся прошлого пакета — в его папку. Гарды ленты и пакет — `save-flow.ts`.
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
   * Отменяет и дожидается фоновую работу над производным — измерения перекоса и очередь
   * коррекции (M6, KTD-12): выход из приложения (`will-quit`; окно и проход — `interrupt`) и
   * закрытие каталога сессии хранилищем. Отменённые страницы остаются без записи до следующего
   * открытия сессии.
   */
  settleDerived(): Promise<void>;
  /** Страницы текущей сессии — для схемы изображений и миниатюр. */
  pageInfo(key: string): PageInfo | null;
  readPage(key: string): Promise<Result<Uint8Array>>;
  /**
   * Выправленные файлы текущей сессии (M6, KTD-11): `resolve` — единственный источник пути для
   * миниатюр выправленных, `read` — байты со сверкой размера по записи о коррекции.
   */
  straightenedFiles(): Pick<Straightened, 'resolve' | 'read'>;
  /** Байты выправленной страницы для протокола картинок; нет записи — `notStraightened`. */
  readStraightened(key: string): Promise<Result<Uint8Array>>;
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
  /** Выправленные страницы (M6, KTD-11): записи уже прочитаны при открытии. */
  readonly straightened: Straightened;
  /**
   * Очередь коррекции (M6, KTD-12) — фабрикой: её «снимок изменился» — это `notify` службы,
   * который появляется только внутри неё.
   */
  readonly straightenQueue: (onChange: () => void) => StraightenQueue;
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
  { store, settings, unclosedJobs, notices, blank, skew, straightened, ...deps }: Dependencies,
  options: PassServiceOptions = {},
): PassService {
  const jobLimits: ScanJobLimits = { ...SCAN_JOB_LIMITS, ...options.jobLimits };
  const connector = options.connector ?? {};
  const newTransport = (profile: ConnectedScanner['profile']): ScannerTransport =>
    (connector.createTransport ?? createTransport)(profile, connector.limits);

  let run: Run | null = null;
  /** Сохранение PDF идёт: второй вызов — конфликт, а не два диалога и две записи в один путь. */
  let saving = false;
  let seq = 0;

  const notify = (): void => {
    seq += 1;
    options.onChange?.(seq);
  };
  const straightenQueue = deps.straightenQueue(notify);
  // Сборка ленты с оценками пустоты и фактами выравнивания (KTD-9) — одна на снимок и пакет;
  // состояние очереди снимается один раз на снимок (оно же идёт в прогресс).
  const assembly = (
    session: SessionSnapshot,
    queue: StraightenQueueState = straightenQueue.state(),
  ): SessionAssembly =>
    assembleSession(
      session,
      blank.verdicts(),
      straightenFactsOf(session, skew.verdicts(), straightened, queue),
    );
  const writer = createDocumentWriter({
    store,
    assemble: assembly,
    straightened,
    io: ioOf(options),
    onSaved: notify,
  });
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
          // Исход «выправлять» — в очередь коррекции; остальным очередь отказывает сама (KTD-12).
          straightenQueue.enqueue(key);
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
  // Страницы с исходом «выправлять» без записи текущей версии — в очередь коррекции (AE8, AE13;
  // отложенные по месту или сбою в прошлый раз — попытка снова, R27).
  measurePending();
  straightenQueue.ensureAll();
  /** Отброшенные страницы («Остановить», «Новая пачка», пересъём) теряют и вердикты. */
  const pruneScores = (): void => {
    blank.prune();
    skew.prune();
    straightened.prune();
    straightenQueue.prune();
  };
  /**
   * Возобновляет измерения и коррекцию после отмены (KTD-12), которую сделало закрытие каталога
   * сессии: если закрытие не состоялось (`sessionCloseFailed`, KTD-33) или сессия осталась
   * после «Остановить», отменённые страницы иначе ждали бы перезапуска, а сохранение отказывало
   * бы `straightenPending` навечно (ревью сессий 3–4). Идемпотентно: измеренным и выправленным
   * страницам `ensure` и `enqueue` ничего не делают.
   */
  // Возобновление после `settleDerived`, когда каталог сессии остался (`sessionCloseFailed`,
  // «Остановить» с оставшимися страницами): отменённые оценки пустоты запускаются заново (B-18) —
  // иначе страницы остались бы `pending` до перезапуска, `blankPending` блокировал бы запись, а
  // измерение перекоса ждало бы вердиктов; затем перекос и очередь коррекции.
  const resumeDerived = (): void => {
    for (const page of pagesToScore(store.snapshot())) {
      detectBlank(page.key);
    }
    measurePending();
    straightenQueue.ensureAll();
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

  function snapshot(): Snapshot {
    const session = store.snapshot();
    const last = session?.passes.at(-1);
    const queue = straightenQueue.state();
    return {
      seq,
      scanner: scanner.state(),
      session,
      assembly: session === null ? null : assembly(session, queue),
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
      straightenProgress: straightenProgressOf(session, queue),
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
      // Режимы сессии заморожены в журнале (R2, R14): читаются раз на проход, а не на каждую
      // страницу — `store.snapshot()` собирает все проходы, а `sink` не должен ждать лишнего.
      const scoring = detectsBlank(current.kind);
      const measuring = straightens();

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
          if (scoring) {
            // Оборот сначала получает вердикт пустоты; измерение перекоса — по нему (R6).
            detectBlank(accepted.key);
          } else if (measuring) {
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
      // Закрытие каталога на этом пути могло отменить производное и не состояться — возобновить.
      pruneScores();
      resumeDerived();
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

    async setStraightenMode(mode) {
      // Настройка приложения: сессия берёт её только при старте первого прохода (R14).
      const saved = await settings.setStraightenMode(mode);
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
        return refusedSave() ?? (await writer.write(folder, request));
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
        writer.forget();
        pruneScores();
      } else {
        // Сессия осталась (KTD-33), а производное уже отменено — вернуть его в работу.
        resumeDerived();
      }
      notify();
      return closed;
    },

    lastBatchFolder: () => writer.lastFolder(),
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

    async settleDerived() {
      blank.abort();
      skew.abort();
      straightenQueue.abort();
      await Promise.all([blank.settle(), skew.settle(), straightenQueue.settle()]);
    },

    pageInfo: (key) => store.pageInfo(key),
    readPage: (key) => store.readPage(key),
    straightenedFiles: () => straightened,

    readStraightened(key) {
      const file = straightened.resolve(key);
      return file === null
        ? Promise.resolve(fail('pageUnavailable', { reason: 'notStraightened' }))
        : straightened.read(file);
    },
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
  const { derivedDir, root } = layoutOf(dataRoot);
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
  // Выправленные страницы и очередь коррекции (KTD-11, KTD-12, KTD-13): записи читаются при
  // открытии — параллельно с кэшем оценок перекоса, они независимы; недостающее — в очередь;
  // место проверяется тем же резервом, что перед проходом.
  const straightened = createStraightened(derivedDir, store, options);
  const session = store.snapshot();
  await Promise.all([
    skew.load(pagesToMeasure(session, blank.verdicts()).map((page) => page.key)),
    straightened.load(session?.passes.flatMap((pass) => pass.pages.map((page) => page.key)) ?? []),
  ]);
  const { fs } = ioOf(options);
  const service = createPassService(
    {
      store,
      settings,
      unclosedJobs,
      notices: settings.notice === null ? notices : [...notices, settings.notice],
      blank,
      skew,
      straightened,
      straightenQueue: (onChange) =>
        createStraightenQueue({
          source: store,
          skew,
          straightened,
          worker: { straighten: (bytes, profile, job) => worker.straighten(bytes, profile, job) },
          freeBytes: () => fs.freeBytes(root),
          minFreeBytes: options.minFreeBytes ?? MIN_FREE_BYTES,
          onChange,
        }),
    },
    options,
  );
  derived.settle = () => service.settleDerived();
  return service;
}
