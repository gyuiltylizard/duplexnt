import { join } from 'node:path';
import {
  EMPTY_EDITS,
  fail,
  isBacksKind,
  ok,
  sameEdits,
  sessionConflict,
  type AddedPassIntent,
  type BlankMode,
  type Result,
  type SessionEdits,
  type SessionSnapshot,
  type StartPassRequest,
} from '@shared';
import {
  autoDividerOf,
  baseAssembly,
  baseKeysOf,
  frozenSequenceOf,
  setsLayoutOf,
} from '../scan/assembly';
import { visibleKeysOf } from '../scan/edits';
import { isTempName, removeByPrefix, renameWithRetry, writeStreamAtomic } from './atomic-file';
import {
  addedSetsOfJournal,
  isVacant,
  JOURNAL_VERSION,
  journalSchema,
  newJournal,
  nextKindOf,
  NOTHING_LOST,
  pageCountOf,
  pagesOf,
  passSnapshotsOf,
  passStateOf,
  pendingPairOf,
  rolesOf,
  runningSegmentOf,
  withLastPass,
  withLastSegment,
  type Journal,
  type JournalPass,
  type JournalSegment,
  type PassOrigin,
} from './journal';
import {
  BLANK_FILE,
  blankDirOf,
  closingDirOf,
  derivedDirOf,
  JOURNAL_FILE_NAME,
  layoutOf,
  MAX_PAGE_INDEX,
  MAX_PASS_NUMBER,
  MAX_SEGMENT_NUMBER,
  newSessionId as randomSessionId,
  PAGE_FILE,
  pageFileName,
  pageKey,
  PAGES_DIR_NAME,
  segmentPrefix,
  thumbsDirOf,
} from './layout';
import {
  checkIntent,
  conflict,
  locatePass,
  planPass,
  REFUSAL,
  resumable,
  type PassPlan,
  type PolicyState,
} from './pass-policy';
import { withRebasedEdits } from './rebase';
import {
  fsErrorCode,
  isMissing,
  ioOf,
  listDir,
  serialQueue,
  StorageError,
  storageFailure,
  type StorageFs,
  type StorageOptions,
} from './storage-fs';
import { isSetAsideName, setAside, writeVersioned } from './versioned-file';

// Хранилище сессии: журнал, страницы, проходы и сегменты (ADR 0004 с амендментом; план M1, U13).
//
// Порядок записи — то, на чём держится «отсканированное не теряется»:
// - начало сегмента попадает в журнал ДО запроса к сканеру (KTD-17); не записалось — старта нет;
// - страница: временный файл → `fsync` → переименование → перезапись журнала (KTD-18). Сбой между
//   шагами даёт страницу без записи — сверка при запуске возвращает её по ключу;
// - удаление сегмента: пометка в журнале → удаление файлов по префиксу → снятие пометки (KTD-20).
//   Файлы удаляются только после успешной записи пометки;
// - закрытие сессии: переименование каталога целиком, затем очистка (KTD-33). Не переименовался —
//   сессия остаётся целой и рабочей.
//
// Операции идут строго по очереди. Журнал в памяти неизменяем: операция строит новый и пробует
// его записать. Запись, от которой зависит следующий шаг (начало сегмента, пометка об удалении,
// решение пользователя), обязана пройти — иначе операция отклонена и состояние прежнее. Остальное
// (страница, исход сегмента, снятие пометки) при отказе записи остаётся в памяти несохранённым:
// страница уже на диске, и следующая перезапись журнала это доводит (KTD-36).

/** Запас свободного места перед проходом (KTD-36): 50 листов по 3,5 МБ с запасом (журнал, U1). */
const MIN_FREE_BYTES = 500 * 1024 * 1024;

export interface SessionStoreOptions extends StorageOptions {
  readonly newSessionId?: () => string;
  readonly minFreeBytes?: number;
}

/** С чем хранилище открывается: результат сверки при запуске (./reconcile.ts). */
export interface SessionState {
  /** Данные более новой версии: режим отказа, ни одна изменяющая операция не проходит (KTD-35). */
  readonly incompatible: boolean;
  readonly journal: Journal | null;
  /** Ключи страниц, у которых запись есть, а файла нет. */
  readonly lost: ReadonlySet<string>;
  /** Журнал в памяти новее записанного: сверке не удалось его записать. */
  readonly unsaved: boolean;
  /**
   * На месте журнала лежит нечитаемый файл, который сверке не удалось сохранить в стороне
   * (KTD-34): первая запись журнала сначала отодвигает его, а не выйдет — не делается.
   */
  readonly unpreserved: boolean;
}

export const NO_SESSION: SessionState = {
  incompatible: false,
  journal: null,
  lost: new Set(),
  unsaved: false,
  unpreserved: false,
};

export type { PassPlan } from './pass-policy';

export interface SegmentStart {
  readonly pass: number;
  readonly segment: number;
  /** Сканер и параметры прохода: досканирование идёт с ними же (KTD-27). */
  readonly origin: PassOrigin;
  /** Номер в проходе, который получит первая страница сегмента. */
  readonly firstPageNumber: number;
}

export interface AcceptedPage {
  readonly key: string;
  /** Номер в проходе. */
  readonly number: number;
  readonly bytes: number;
}

export interface PageInfo {
  readonly sessionId: string;
  /** Предел пикселей страницы из журнала (KTD-37); `null` — параметры прохода неизвестны. */
  readonly pixelLimit: number | null;
  /** DPI прохода — размер страницы PDF (M2, KTD-9); `null` — параметры прохода неизвестны. */
  readonly dpi: number | null;
}

export interface SessionStore {
  readonly incompatible: boolean;
  /** Сессия, как её видит интерфейс; `null` — сессии нет. */
  snapshot(): SessionSnapshot | null;
  /** Журнал в памяти новее записанного на диск. */
  unsaved(): boolean;
  /**
   * Монотонный счётчик изменений журнала в памяти (включая несохранённые на диск). Снятый до
   * долгой операции, он позволяет проверить «набор не менялся» без сравнения содержимого.
   */
  revision(): number;
  /**
   * Политика запуска — чистый запрос над журналом, одно место правила для службы (до сети) и
   * хранилища (M3.5, KTD-5). Без намерения: прерванный последний проход — досканирование
   * (отказы `resumeTarget`), лицевые без оборотов — обороты (`backsDeclined` / `backsPresent`
   * отказывают), пустая сессия — лицевые. Намерение `added`: без сессии — `noSession`, при
   * прерванном последнем — `passInterrupted` (иначе лицевые застряли бы прерванными навсегда),
   * якорь не из сессии — `invalidInput`; отказ от оборотов и их наличие не мешают.
   */
  planPass(request: StartPassRequest): Result<PassPlan>;
  /**
   * Новый проход: первый сегмент «идёт» записан в журнал. Вызывается до `POST`. Роль и якорь
   * пишутся сразу (журнал v4): по намерению (`AddedPassIntent`) или по очереди (`nextKindOf`).
   * Намерение проверяется той же проверкой, что в `planPass`. Режим пустых оборотов (M4, R2)
   * замораживается в журнале, когда проход открывает сессию — новую или заново после пустой;
   * дальше аргумент не читается.
   */
  beginPass(
    origin: PassOrigin,
    intent: AddedPassIntent | null,
    blankMode?: BlankMode,
  ): Promise<Result<SegmentStart>>;
  /** С чем можно досканировать последний проход; отказ — досканировать нельзя. */
  resumeTarget(): Result<PassOrigin>;
  /** Досканирование прерванного прохода: новый сегмент того же прохода. */
  resumePass(): Promise<Result<SegmentStart>>;
  /**
   * Принимает страницу в идущий сегмент и возвращается, когда файл на диске. Бросает: ошибку
   * источника — как есть (её различает задание), отказ хранилища — `StorageError`.
   */
  acceptPage(body: AsyncIterable<Uint8Array>): Promise<AcceptedPage>;
  /** Исход идущего сегмента. «Завершён» пишется до `DELETE` (KTD-17). */
  endSegment(outcome: 'completed' | 'interrupted'): Promise<Result<void>>;
  /**
   * «Остановить»: удаляет идущий сегмент со страницами. Если страниц в сессии после этого нет,
   * сессия закрывается целиком.
   */
  discardSegment(): Promise<Result<{ readonly sessionClosed: boolean }>>;
  /** «Оставить как есть»: прерванный проход принят. */
  acceptPass(): Promise<Result<void>>;
  /**
   * Правки редактора (M3, KTD-3): итоговое состояние целиком и флаги поворота на 180° по
   * проходам оборотов — основной пачки и наборов (M4.5, KTD4; номер прохода → флаг, не названные
   * — `false`) — одной записью журнала, чтобы «Вернуть» был одним шагом. Номер прохода не роли
   * оборотов — `noBacksPass`. Правка снимает отметку о сохранении; во время прохода отклоняется.
   * Нормализация — забота хранилища, не вызывающего.
   */
  setEdits(
    edits: SessionEdits,
    rotate180: Readonly<Record<number, boolean>>,
  ): Promise<Result<void>>;
  /**
   * «Обороты не нужны» (M2, KTD-6): durable-отметка, `flip` больше не показывается. Адресуется
   * набору, ждущему обороты, если он есть (M4.5, KTD3: `backsDecision: 'declined'` на его
   * лицах), иначе сессии.
   */
  declineBacks(): Promise<Result<void>>;
  /**
   * «Оставить как есть» для набора «ДN» с несовпавшими оборотами (M4.5, KTD3): durable
   * `backsDecision: 'kept'`, модалка набора больше не показывается. Отказы: `noPendingSet`,
   * `setNotMismatched` (числа равны или решение уже есть).
   */
  keepSetBacks(set: number): Promise<Result<void>>;
  /**
   * «Переснять обороты набора» (M4.5, KTD3; ADR 0004, амендмент 2026-10-23): проход оборотов
   * набора отбрасывается целиком — запись журнала с пометками об удалении раньше файлов, затем
   * удаление страниц и производного; правки по исчезнувшим ключам чистит нормализация. После
   * этого набор снова ждёт обороты. Отказы — как у `keepSetBacks`.
   */
  rescanSetBacks(set: number): Promise<Result<void>>;
  /**
   * «Собрать документ» (M3.6, R12, R13; KTD5): в режиме раздельных наборов с равными ненулевыми
   * видимыми числами групп пишет запись сборки (R7), обнуляет порядок и границу, снимает
   * «сохранено» — одним коммитом; повороты и удаления остаются. Отказы по порядку R13:
   * `noSession`, `passRunning`, `passInterrupted`, `notSeparate`, `setsUnequal`.
   */
  assemble(): Promise<Result<void>>;
  /**
   * Набор сохранён в PDF (M2, R12); ставится после успешной записи файла. С `expectedRevision`
   * отметка ставится, только если журнал не менялся с момента снятия ревизии: правка во время
   * сборки и записи уже сняла отметку, и затирать её устаревшим «сохранено» нельзя.
   */
  markSaved(expectedRevision?: number): Promise<Result<void>>;
  /** «Новая пачка»: единственное, что удаляет сессию со страницами. */
  closeSession(): Promise<Result<void>>;
  /** Повторяет запись журнала, если состояние в памяти не сохранено. */
  flush(): Promise<Result<void>>;
  /** Страница текущей сессии, у которой есть файл; иначе `null`. */
  pageInfo(key: string): PageInfo | null;
  /** Исходник страницы — в буфер: дескриптор не остаётся открытым (KTD-33). */
  readPage(key: string): Promise<Result<Uint8Array>>;
}

const unavailable = (reason: 'unknown' | 'lost'): Result<never> =>
  fail('pageUnavailable', { reason });

const runningSegment = (number: number): JournalSegment => ({
  number,
  state: 'running',
  pageCount: 0,
});

const isJournalFile = (name: string): boolean =>
  name === JOURNAL_FILE_NAME ||
  (name.startsWith(`${JOURNAL_FILE_NAME}.`) &&
    (isTempName(name) || isSetAsideName(name, JOURNAL_FILE_NAME)));

/**
 * Очистка закрытой сессии: удаляются только файлы, которые хранилище само создаёт. Посторонний
 * файл остаётся, и каталог вместе с ним. Всё — по возможности: недочищенное доводит сверка.
 */
export async function sweepClosedSession(fs: StorageFs, directory: string): Promise<void> {
  const attempt = (action: Promise<unknown>): Promise<unknown> => action.catch(() => undefined);
  const list = (path: string): Promise<string[]> => listDir(fs, path).catch(() => []);

  const pagesDir = join(directory, PAGES_DIR_NAME);
  for (const name of await list(pagesDir)) {
    if (PAGE_FILE.test(name) || isTempName(name)) {
      await attempt(fs.unlink(join(pagesDir, name)));
    }
  }
  await attempt(fs.rmdir(pagesDir));
  for (const name of await list(directory)) {
    if (isJournalFile(name)) {
      await attempt(fs.unlink(join(directory, name)));
    }
  }
  await attempt(fs.rmdir(directory));
}

export function createSessionStore(
  dataRoot: string,
  initial: SessionState = NO_SESSION,
  options: SessionStoreOptions = {},
): SessionStore {
  const layout = layoutOf(dataRoot);
  const io = ioOf(options);
  const { fs } = io;
  const newSessionId = options.newSessionId ?? randomSessionId;
  const minFreeBytes = options.minFreeBytes ?? MIN_FREE_BYTES;
  const { incompatible } = initial;

  let journal = initial.journal;
  let unsaved = initial.unsaved;
  let unpreserved = initial.unpreserved;
  let revision = 0;
  const lost = new Set(initial.lost);

  const enqueue = serialQueue();
  // Изменяющая операция: в режиме отказа отклоняется, не начавшись (KTD-35). Проверка стоит в
  // одном месте — новая операция не может её забыть.
  const mutating = <T>(operation: () => Promise<Result<T>>): Promise<Result<T>> =>
    enqueue(() =>
      incompatible ? Promise.resolve<Result<T>>({ ok: false, error: REFUSAL }) : operation(),
    );

  // Идущие чтения страниц: закрытие сессии и удаление сегмента их дожидаются.
  const reads = new Set<Promise<unknown>>();
  let closing = false;
  const settleReads = (): Promise<unknown> => Promise.allSettled([...reads]);

  async function commit(proposed: Journal, mode: 'must' | 'soft'): Promise<Result<void>> {
    // Нормализация правок — в одном месте: ни одна операция не запишет правки, расходящиеся со
    // страницами (KTD-3a, KTD-10).
    const next = withRebasedEdits(journal, proposed);
    try {
      if (unpreserved) {
        await setAside(layout.journalFile, io);
        unpreserved = false;
      }
      await writeVersioned(layout.journalFile, journalSchema, JOURNAL_VERSION, next, io);
    } catch (error) {
      if (mode === 'soft') {
        journal = next;
        unsaved = true;
        revision += 1;
      }
      return { ok: false, error: storageFailure(error) };
    }
    journal = next;
    unsaved = false;
    revision += 1;
    return ok(undefined);
  }

  async function checkFreeSpace(): Promise<Result<void>> {
    let free: number;
    try {
      await fs.mkdir(layout.root);
      free = await fs.freeBytes(layout.root);
    } catch {
      // Не удалось узнать — не причина отказать в проходе: настоящий отказ даст сама запись.
      return ok(undefined);
    }
    return free < minFreeBytes ? fail('storageFull') : ok(undefined);
  }

  // Сегмент не начинается на префиксе, под которым есть файлы или пометка об удалении (KTD-17):
  // иначе страницы отброшенного сегмента смешались бы с новыми.
  async function freeSegmentNumber(
    current: Journal,
    pass: number,
    from: number,
  ): Promise<Result<number>> {
    let names: string[];
    try {
      names = await listDir(fs, layout.pagesDir);
    } catch (error) {
      return { ok: false, error: storageFailure(error) };
    }
    for (let segment = from; segment <= MAX_SEGMENT_NUMBER; segment += 1) {
      const prefix = segmentPrefix(pass, segment);
      if (!current.deletions.includes(prefix) && !names.some((name) => name.startsWith(prefix))) {
        return ok(segment);
      }
    }
    return fail('storageFailed', { reason: 'segmentLimit' });
  }

  /** Состояние для политики запуска (`./pass-policy.ts`) — журнал в памяти и режим отказа. */
  const state = (): PolicyState => ({ journal, incompatible });

  /** Двусторонний набор «ДN» с проходами лиц и оборотов; `null` — набора нет или оборотов у него нет. */
  function twoSidedSet(
    current: Journal,
    set: number,
  ): { readonly fronts: JournalPass; readonly backs: JournalPass } | null {
    const found = addedSetsOfJournal(current).find((it) => it.set === set && it.sides === 'two');
    const fronts = current.passes.find((pass) => pass.number === found?.fronts);
    const backs = current.passes.find((pass) => pass.number === found?.backs);
    return fronts === undefined || backs === undefined ? null : { fronts, backs };
  }

  /**
   * Набор «ДN» с несовпавшими оборотами, по которому ещё можно решать (M4.5, KTD3): общий
   * гард «Оставить как есть» и «Переснять» — сессия есть, проход не идёт, набор с оборотами
   * найден, числа не равны и решения ещё нет.
   */
  function mismatchedSetOf(set: number): Result<{
    readonly journal: Journal;
    readonly fronts: JournalPass;
    readonly backs: JournalPass;
  }> {
    if (journal === null || isVacant(journal)) {
      return conflict('noSession');
    }
    if (runningSegmentOf(journal) !== null) {
      return conflict('passRunning');
    }
    const found = twoSidedSet(journal, set);
    if (found === null) {
      return conflict('noPendingSet');
    }
    const { fronts, backs } = found;
    return fronts.backsDecision !== 'none' || pagesOf(backs).length === pagesOf(fronts).length
      ? conflict('setNotMismatched')
      : ok({ journal, fronts, backs });
  }

  /** Журнал с решением по оборотам набора на проходе его лиц (M4.5, KTD1). */
  const withDecision = (
    current: Journal,
    fronts: JournalPass,
    backsDecision: 'declined' | 'kept',
  ): Journal => ({
    ...current,
    passes: current.passes.map((pass) => (pass === fronts ? { ...pass, backsDecision } : pass)),
  });

  // Переименование каталога сессии и очистка. Пофайлового удаления взамен нет: не
  // переименовался — сессия остаётся целой.
  async function closeDirectory(sessionId: string): Promise<Result<void>> {
    closing = true;
    try {
      await settleReads();
      const target = closingDirOf(layout, sessionId);
      try {
        await renameWithRetry(layout.sessionDir, target, io);
      } catch (error) {
        if (!isMissing(error)) {
          return fail('sessionCloseFailed', { reason: fsErrorCode(error) });
        }
      }
      journal = null;
      unsaved = false;
      revision += 1;
      lost.clear();
      await sweepClosedSession(fs, target);
      await fs.removeTree(derivedDirOf(layout, sessionId)).catch(() => undefined);
      return ok(undefined);
    } finally {
      closing = false;
    }
  }

  // Удаление файлов под пометкой. Пометка снимается, когда не осталось ни одного файла;
  // неудаляемый файл оставляет её, и удаление доводит сверка при запуске.
  async function removeMarked(sessionId: string, prefix: string): Promise<void> {
    try {
      const report = await removeByPrefix(layout.pagesDir, prefix, PAGE_FILE, io);
      // Миниатюры и оценки пустых страниц отброшенных страниц — производное: чистятся по
      // возможности.
      await removeByPrefix(thumbsDirOf(layout, sessionId), prefix, PAGE_FILE, io).catch(
        () => undefined,
      );
      await removeByPrefix(blankDirOf(layout, sessionId), prefix, BLANK_FILE, io).catch(
        () => undefined,
      );
      if (report.failed.length === 0 && journal !== null) {
        const deletions = journal.deletions.filter((it) => it !== prefix);
        await commit({ ...journal, deletions }, 'soft');
      }
    } catch {
      // Каталог не читается: пометка остаётся.
    }
  }

  return {
    incompatible,

    snapshot() {
      if (journal === null || isVacant(journal)) {
        return null;
      }
      return {
        id: journal.sessionId,
        backsDeclined: journal.backsDeclined,
        saved: journal.saved,
        passes: passSnapshotsOf(journal, lost),
        edits: journal.edits,
        assembled: journal.assembled,
        blankMode: journal.blankMode,
      };
    },

    unsaved: () => unsaved,

    revision: () => revision,

    planPass: (request) => planPass(state(), request),

    beginPass: (origin, intent, blankMode = 'keep') =>
      mutating(async () => {
        if (runningSegmentOf(journal) !== null) {
          return conflict('passRunning');
        }
        const checked = checkIntent(state(), intent);
        if (!checked.ok) {
          return checked;
        }
        // Роль по очереди — та же `nextKindOf`, что в `planPass`: между планом и записью журнал
        // не меняется, служба держит `run` и отклоняет остальные мутации (`passRunning`).
        const space = await checkFreeSpace();
        if (!space.ok) {
          return space;
        }
        // Пустой журнал — не сессия: проход начинается заново, пустые проходы в новую не идут.
        // Пометки об удалении и счётчики при этом остаются: без них неудалённые файлы
        // отброшенного сегмента вернулись бы страницами. Решения прежней сессии (отказ от
        // оборотов, отметка о сохранении, правки) с ней и уходят.
        const base =
          journal === null || (isVacant(journal) && journal.deletions.length === 0)
            ? { ...newJournal(newSessionId()), blankMode }
            : isVacant(journal)
              ? {
                  ...journal,
                  passes: [],
                  backsDeclined: false,
                  saved: false,
                  edits: EMPTY_EDITS,
                  assembled: null,
                  blankMode,
                }
              : journal;
        const number = base.nextPass;
        if (number > MAX_PASS_NUMBER) {
          return fail('storageFailed', { reason: 'passLimit' });
        }
        try {
          await fs.mkdir(layout.pagesDir);
        } catch (error) {
          return { ok: false, error: storageFailure(error) };
        }
        const segment = await freeSegmentNumber(base, number, 1);
        if (!segment.ok) {
          return segment;
        }
        const kind = intent?.kind ?? nextKindOf(base);
        const pass: JournalPass = {
          number,
          kind,
          after: intent?.after ?? null,
          // Обороты набора ссылаются на лица ожидающего набора из того же журнала (M4.5, KTD1).
          pair: kind === 'addedBacks' ? (pendingPairOf(base)?.fronts ?? null) : null,
          backsDecision: kind === 'addedFronts' ? 'none' : null,
          accepted: false,
          origin,
          nextSegment: segment.value + 1,
          segments: [runningSegment(segment.value)],
          rotate180: false,
        };
        const saved = await commit(
          { ...base, nextPass: number + 1, passes: [...base.passes, pass] },
          'must',
        );
        return saved.ok
          ? ok({ pass: number, segment: segment.value, origin, firstPageNumber: 1 })
          : saved;
      }),

    resumeTarget() {
      const target = resumable(state());
      return target.ok ? ok(target.value.origin) : target;
    },

    resumePass: () =>
      mutating(async () => {
        const target = resumable(state());
        if (!target.ok || journal === null) {
          return target.ok ? conflict('noSession') : target;
        }
        const pass = target.value;
        const space = await checkFreeSpace();
        if (!space.ok) {
          return space;
        }
        // Каталога страниц может не быть: все страницы потеряны вместе с ним, а записи остались.
        try {
          await fs.mkdir(layout.pagesDir);
        } catch (error) {
          return { ok: false, error: storageFailure(error) };
        }
        const segment = await freeSegmentNumber(journal, pass.number, pass.nextSegment);
        if (!segment.ok) {
          return segment;
        }
        const saved = await commit(
          withLastPass(journal, {
            ...pass,
            nextSegment: segment.value + 1,
            segments: [...pass.segments, runningSegment(segment.value)],
          }),
          'must',
        );
        return saved.ok
          ? ok({
              pass: pass.number,
              segment: segment.value,
              origin: pass.origin,
              firstPageNumber: pagesOf(pass).length + 1,
            })
          : saved;
      }),

    acceptPage: (body) =>
      enqueue(async () => {
        if (incompatible) {
          throw new StorageError(REFUSAL);
        }
        const running = runningSegmentOf(journal);
        if (running === null || journal === null) {
          throw new StorageError(sessionConflict('noRunningPass'));
        }
        const { pass, segment } = running;
        const index = segment.pageCount + 1;
        if (index > MAX_PAGE_INDEX) {
          throw new StorageError({ code: 'storageFailed', details: { reason: 'pageLimit' } });
        }
        const key = pageKey({ pass: pass.number, segment: segment.number, index });

        // Ошибка источника (сеть, проверка маркеров в задании) отличается от ошибки записи: первую
        // вызывающий должен получить как есть. Пустое тело до переименования не доходит.
        const source = { failed: false, error: undefined as unknown };
        async function* guarded(): AsyncGenerator<Uint8Array> {
          let received = 0;
          try {
            for await (const chunk of body) {
              received += chunk.byteLength;
              yield chunk;
            }
          } catch (error) {
            source.failed = true;
            source.error = error;
            throw error;
          }
          if (received === 0) {
            throw new StorageError({ code: 'storageFailed', details: { reason: 'emptyPage' } });
          }
        }

        let bytes: number;
        try {
          bytes = await writeStreamAtomic(join(layout.pagesDir, pageFileName(key)), guarded(), io);
        } catch (error) {
          if (source.failed && error === source.error) {
            throw error;
          }
          throw new StorageError(storageFailure(error));
        }

        const number = pagesOf(pass).length + 1;
        // Новая страница меняет вывод: отметка о сохранении снимается (KTD-7).
        await commit(
          {
            ...withLastPass(journal, withLastSegment(pass, { ...segment, pageCount: index })),
            saved: false,
          },
          'soft',
        );
        return { key, number, bytes };
      }),

    endSegment: (outcome) =>
      mutating(async () => {
        const running = runningSegmentOf(journal);
        if (running === null || journal === null) {
          return conflict('noRunningPass');
        }
        const { pass, segment } = running;
        await commit(
          withLastPass(journal, withLastSegment(pass, { ...segment, state: outcome })),
          'soft',
        );
        return ok(undefined);
      }),

    discardSegment: () =>
      mutating<{ readonly sessionClosed: boolean }>(async () => {
        const running = runningSegmentOf(journal);
        if (running === null || journal === null) {
          return conflict('noRunningPass');
        }
        const { pass, segment } = running;
        const { sessionId } = journal;
        // «Остановить», которое не удалось довести, превращается в «прерван»: файлы целы.
        const interrupted = withLastPass(
          journal,
          withLastSegment(pass, { ...segment, state: 'interrupted' }),
        );
        // Удаление страниц меняет вывод — отметка о сохранении снимается; пустой сегмент
        // вывода не менял.
        const remaining = {
          ...withLastPass(
            journal,
            pass.segments.length > 1 ? { ...pass, segments: pass.segments.slice(0, -1) } : null,
          ),
          saved: segment.pageCount === 0 ? journal.saved : false,
        };

        // Остановка, после которой в сессии нет страниц, идёт путём закрытия сессии (KTD-20).
        if (pageCountOf(remaining) === 0) {
          const closed = await closeDirectory(sessionId);
          if (!closed.ok) {
            await commit(interrupted, 'soft');
            // Страниц не было вовсе — защищать нечего: журнал пуст, и для вызывающего сессии нет.
            // Каталог дочистит сверка при запуске.
            return pageCountOf(interrupted) === 0 ? ok({ sessionClosed: true }) : closed;
          }
          return ok({ sessionClosed: true });
        }

        const prefix = segmentPrefix(pass.number, segment.number);
        const marked = await commit(
          { ...remaining, deletions: [...remaining.deletions, prefix] },
          'must',
        );
        if (!marked.ok) {
          await commit(interrupted, 'soft');
          return marked;
        }
        // Страницы сегмента уже не выдаются; идущие чтения дочитывают и закрывают файл.
        await settleReads();
        await removeMarked(sessionId, prefix);
        return ok({ sessionClosed: false });
      }),

    acceptPass: () =>
      mutating(async () => {
        const pass = journal?.passes.at(-1);
        if (pass === undefined || journal === null || isVacant(journal)) {
          return conflict('noSession');
        }
        const passState = passStateOf(pass);
        if (passState !== 'interrupted') {
          return conflict(passState === 'running' ? 'passRunning' : 'notInterrupted');
        }
        let accepted = withLastPass(journal, { ...pass, accepted: true });
        // Принятые короткие обороты набора — то же «оставить как есть» (M4.5, R15): модалка
        // несовпадения набора после них не показывается.
        const setFronts = accepted.passes.find(
          (it) =>
            pass.kind === 'addedBacks' && it.number === pass.pair && it.kind === 'addedFronts',
        );
        if (
          setFronts?.backsDecision === 'none' &&
          pagesOf(pass).length !== pagesOf(setFronts).length
        ) {
          accepted = withDecision(accepted, setFronts, 'kept');
        }
        return commit(accepted, 'must');
      }),

    setEdits: (edits, rotate180) =>
      mutating(async () => {
        if (journal === null || isVacant(journal)) {
          return conflict('noSession');
        }
        // Лента во время прохода растёт: правка поверх неё легла бы на чужие позиции (KTD-9).
        if (runningSegmentOf(journal) !== null) {
          return conflict('passRunning');
        }
        // Флаг адресует проход оборотов — основной пачки или набора (M4.5, KTD4); чужой номер,
        // проход другой роли или без страниц (роли не занимает) — отказ целиком, без частичной
        // записи.
        const isBacks = (pass: JournalPass): boolean =>
          isBacksKind(pass.kind) && pagesOf(pass).length > 0;
        const current = journal;
        const addressed = Object.keys(rotate180).map(Number);
        if (
          addressed.some((number) => {
            const pass = current.passes.find((it) => it.number === number);
            return pass === undefined || !isBacks(pass);
          })
        ) {
          return conflict('noBacksPass');
        }
        const passes = journal.passes.map((pass) =>
          isBacks(pass) ? { ...pass, rotate180: rotate180[pass.number] ?? false } : pass,
        );
        // Сравнение — после нормализации: состояние, которое приводится к записанному, правкой
        // не считается и отметку о сохранении не снимает. Страницы те же — переносить нечего.
        const normalized = withRebasedEdits(null, { ...journal, edits }).edits;
        const flagsSame = passes.every(
          (pass, index) => pass.rotate180 === current.passes[index]?.rotate180,
        );
        if (flagsSame && sameEdits(journal.edits, normalized)) {
          return ok(undefined);
        }
        // Правка меняет вывод: сохранённый PDF устарел (M3, R8).
        return commit({ ...journal, passes, edits: normalized, saved: false }, 'must');
      }),

    declineBacks: () =>
      mutating(async () => {
        if (journal === null || isVacant(journal)) {
          return conflict('noSession');
        }
        if (runningSegmentOf(journal) !== null) {
          return conflict('passRunning');
        }
        // Пустой проход оборотов (прерван до первой страницы) роли не занимает и отказу не
        // мешает — но остаться прерванным он не должен: иначе «досканировать» снова начало бы
        // обороты вопреки отказу, а добавление ждало бы «оставить как есть». Страниц и файлов
        // у него нет — запись просто уходит, как при «Остановить» на пустом сегменте.
        const current = journal;
        const last = current.passes.at(-1);
        const trimmedOf = (kind: 'backs' | 'addedBacks'): Journal =>
          last?.kind === kind && pagesOf(last).length === 0 ? withLastPass(current, null) : current;
        // Набор, ждущий обороты, — адресат отказа (M4.5, KTD3): экран `flip` один, команда одна.
        const pending = pendingPairOf(journal);
        if (pending !== null) {
          const trimmed = trimmedOf('addedBacks');
          const fronts = trimmed.passes.find((pass) => pass.number === pending.fronts);
          return fronts === undefined
            ? conflict('noPendingSet')
            : commit(withDecision(trimmed, fronts, 'declined'), 'must');
        }
        if (rolesOf(journal).backs !== null) {
          return conflict('backsPresent');
        }
        if (journal.backsDeclined) {
          return ok(undefined);
        }
        // Вывод не меняется (оборотов и не было) — отметка о сохранении остаётся.
        return commit({ ...trimmedOf('backs'), backsDeclined: true }, 'must');
      }),

    keepSetBacks: (set) =>
      mutating(async () => {
        const found = mismatchedSetOf(set);
        if (!found.ok) {
          return found;
        }
        // Вывод не меняется (подблоки уже в ленте) — отметка о сохранении остаётся.
        return commit(withDecision(found.value.journal, found.value.fronts, 'kept'), 'must');
      }),

    rescanSetBacks: (set) =>
      mutating(async () => {
        const found = mismatchedSetOf(set);
        if (!found.ok) {
          return found;
        }
        const { journal: current, backs } = found.value;
        const { sessionId } = current;
        // Отброс прохода — как «Остановить» на сегменте (KTD-20): пометки об удалении в журнале
        // раньше файлов; не доведённое удаление дочищает сверка при запуске. Правки по ключам
        // прохода вычищает нормализация в `commit`; вывод меняется — отметка снимается.
        const prefixes = backs.segments.map((segment) =>
          segmentPrefix(backs.number, segment.number),
        );
        const marked = await commit(
          {
            ...current,
            passes: current.passes.filter((pass) => pass !== backs),
            deletions: [...current.deletions, ...prefixes],
            saved: false,
          },
          'must',
        );
        if (!marked.ok) {
          return marked;
        }
        // Страницы прохода уже не выдаются; идущие чтения дочитывают и закрывают файл.
        await settleReads();
        for (const prefix of prefixes) {
          await removeMarked(sessionId, prefix);
        }
        return ok(undefined);
      }),

    assemble: () =>
      mutating(async () => {
        if (journal === null || isVacant(journal)) {
          return conflict('noSession');
        }
        if (runningSegmentOf(journal) !== null) {
          return conflict('passRunning');
        }
        const last = journal.passes.at(-1);
        if (last !== undefined && passStateOf(last) === 'interrupted') {
          return conflict('passInterrupted');
        }
        const base = baseAssembly(passSnapshotsOf(journal, NOTHING_LOST), journal.assembled);
        const keys = baseKeysOf(base);
        const visible = visibleKeysOf(keys, journal.edits);
        const sets = setsLayoutOf(visible, journal.edits, autoDividerOf(base, journal.edits));
        if (sets === null) {
          return conflict('notSeparate');
        }
        if (sets.fronts === 0 || sets.fronts !== sets.backs) {
          return conflict('setsUnequal');
        }
        // Запись — решение пользователя (амендмент 2026-10-19): расстановка фиксируется, порядок
        // и граница больше не нужны; сохранённый PDF (если был) устарел.
        return commit(
          {
            ...journal,
            assembled: frozenSequenceOf(keys, journal.edits, sets.divider),
            edits: { ...journal.edits, order: [], divider: null },
            saved: false,
          },
          'must',
        );
      }),

    markSaved: (expectedRevision) =>
      mutating(async () => {
        if (journal === null || isVacant(journal)) {
          return conflict('noSession');
        }
        // Журнал менялся, пока PDF собирался и писался: правка уже сняла отметку, и ставить
        // поверх неё устаревшее «сохранено» нельзя — файл набору больше не соответствует.
        if (expectedRevision !== undefined && expectedRevision !== revision) {
          return ok(undefined);
        }
        if (journal.saved) {
          return ok(undefined);
        }
        // Отметка — следствие уже записанного файла, не решение: при отказе записи журнала
        // остаётся в памяти и доводится следующей перезаписью.
        return commit({ ...journal, saved: true }, 'soft').then(() => ok(undefined));
      }),

    closeSession: () =>
      mutating(async () => {
        if (journal === null) {
          return ok(undefined);
        }
        if (runningSegmentOf(journal) !== null) {
          return conflict('passRunning');
        }
        return closeDirectory(journal.sessionId);
      }),

    flush: () =>
      mutating(async () => {
        return journal === null || !unsaved ? ok(undefined) : commit(journal, 'must');
      }),

    pageInfo(key) {
      const pass = locatePass(journal, key);
      if (pass === null || journal === null || lost.has(key)) {
        return null;
      }
      return {
        sessionId: journal.sessionId,
        pixelLimit: pass.origin?.pixelLimit ?? null,
        dpi: pass.origin?.params.resolution ?? null,
      };
    },

    readPage(key) {
      if (closing || locatePass(journal, key) === null) {
        return Promise.resolve(unavailable('unknown'));
      }
      if (lost.has(key)) {
        return Promise.resolve(unavailable('lost'));
      }
      const reading = (async (): Promise<Result<Uint8Array>> => {
        try {
          const bytes = await fs.readFile(join(layout.pagesDir, pageFileName(key)));
          if (bytes.byteLength > 0) {
            return ok(bytes);
          }
        } catch (error) {
          if (!isMissing(error)) {
            return { ok: false, error: storageFailure(error) };
          }
        }
        // Файла нет или он пуст: страница потеряна, место в проходе сохраняется.
        lost.add(key);
        return unavailable('lost');
      })();
      reads.add(reading);
      void reading.finally(() => reads.delete(reading));
      return reading;
    },
  };
}
