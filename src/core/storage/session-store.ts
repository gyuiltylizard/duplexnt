import { join } from 'node:path';
import {
  EMPTY_EDITS,
  fail,
  ok,
  sessionConflict,
  type DomainError,
  type PassSnapshot,
  type Result,
  type SessionConflictReason,
  type SessionEdits,
  type SessionSnapshot,
} from '@shared';
import { autoKeysOf } from '../scan/assembly';
import { rebaseEdits } from '../scan/edits';
import { isTempName, removeByPrefix, renameWithRetry, writeStreamAtomic } from './atomic-file';
import {
  backsPassOf,
  JOURNAL_VERSION,
  journalSchema,
  newJournal,
  pageCountOf,
  pagesOf,
  passStateOf,
  runningSegmentOf,
  survivingPassesOf,
  withLastPass,
  withLastSegment,
  type Journal,
  type JournalPass,
  type JournalSegment,
  type PassOrigin,
} from './journal';
import {
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
  parsePageKey,
  segmentPrefix,
  thumbsDirOf,
} from './layout';
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
import { scannerInfoOf } from './stored-scanner';
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
  /** Новый проход: первый сегмент «идёт» записан в журнал. Вызывается до `POST`. */
  beginPass(origin: PassOrigin): Promise<Result<SegmentStart>>;
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
   * Правки редактора (M3, KTD-3): итоговое состояние целиком и поворот оборотов на 180° (флаг
   * прохода в роли оборотов — второго уцелевшего, KTD-4) — одной записью журнала, чтобы
   * «Вернуть» был одним шагом. Правка снимает отметку о сохранении; во время
   * прохода отклоняется. Нормализация — забота хранилища, не вызывающего.
   */
  setEdits(edits: SessionEdits, rotate180: boolean): Promise<Result<void>>;
  /** «Обороты не нужны» (M2, KTD-6): durable-отметка, `flip` больше не показывается. */
  declineBacks(): Promise<Result<void>>;
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

const conflict = (reason: SessionConflictReason): Result<never> => ({
  ok: false,
  error: sessionConflict(reason),
});
const REFUSAL: DomainError = { code: 'storageIncompatible' };
const unavailable = (reason: 'unknown' | 'lost'): Result<never> =>
  fail('pageUnavailable', { reason });

const runningSegment = (number: number): JournalSegment => ({
  number,
  state: 'running',
  pageCount: 0,
});

/**
 * Пустая сессия равна отсутствию сессии (ADR 0004, амендмент): журнал без единой записи о
 * странице и без идущего сегмента. На диске он может остаться ради пометки об удалении или до
 * следующего запуска — для вызывающего сессии нет.
 */
const isVacant = (journal: Journal): boolean =>
  pageCountOf(journal) === 0 && runningSegmentOf(journal) === null;

/** Проходы журнала, как их видит снимок; `lost` — ключи страниц без файлов. */
function passSnapshotsOf(journal: Journal, lost: ReadonlySet<string>): PassSnapshot[] {
  return journal.passes.map((pass) => ({
    number: pass.number,
    state: passStateOf(pass),
    paramsKnown: pass.origin !== null,
    scanner: pass.origin === null ? null : scannerInfoOf(pass.origin.scanner),
    rotate180: pass.rotate180,
    pages: pagesOf(pass).map(({ key, number }) => ({ key, number, lost: lost.has(key) })),
  }));
}

const NOTHING_LOST: ReadonlySet<string> = new Set();

/**
 * Журнал с правками в каноническом виде против своих страниц (M3, KTD-3a, KTD-10). Если
 * состав страниц изменился относительно `previous` не через правку (досканирование, отброс
 * сегмента, сверка), разрезы переезжают вслед за страницами; правки исчезнувших ключей
 * вычищаются. Пустые правки не трогаются: им нечего нормализовать.
 */
export function withRebasedEdits(previous: Journal | null, next: Journal): Journal {
  if (next.edits === EMPTY_EDITS) {
    return next;
  }
  const before = previous === null ? null : autoKeysOf(passSnapshotsOf(previous, NOTHING_LOST));
  const after = autoKeysOf(passSnapshotsOf(next, NOTHING_LOST));
  return { ...next, edits: rebaseEdits(before, after, next.edits) };
}

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

  function resumable(): Result<JournalPass & { readonly origin: PassOrigin }> {
    if (incompatible) {
      return { ok: false, error: REFUSAL };
    }
    const pass = journal?.passes.at(-1);
    if (journal === null || pass === undefined || isVacant(journal)) {
      return conflict('noSession');
    }
    const state = passStateOf(pass);
    if (state === 'running') {
      return conflict('passRunning');
    }
    if (state !== 'interrupted') {
      return conflict('notInterrupted');
    }
    const { origin } = pass;
    return origin === null ? conflict('paramsUnknown') : ok({ ...pass, origin });
  }

  function locate(key: string): JournalPass | null {
    const address = parsePageKey(key);
    if (address === null || journal === null) {
      return null;
    }
    const pass = journal.passes.find((it) => it.number === address.pass);
    const segment = pass?.segments.find((it) => it.number === address.segment);
    return pass !== undefined && segment !== undefined && address.index <= segment.pageCount
      ? pass
      : null;
  }

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
      // Миниатюры отброшенных страниц — производное: чистятся по возможности.
      await removeByPrefix(thumbsDirOf(layout, sessionId), prefix, PAGE_FILE, io).catch(
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
      };
    },

    unsaved: () => unsaved,

    revision: () => revision,

    beginPass: (origin) =>
      mutating(async () => {
        if (runningSegmentOf(journal) !== null) {
          return conflict('passRunning');
        }
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
            ? newJournal(newSessionId())
            : isVacant(journal)
              ? { ...journal, passes: [], backsDeclined: false, saved: false, edits: EMPTY_EDITS }
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
        const pass: JournalPass = {
          number,
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
      const target = resumable();
      return target.ok ? ok(target.value.origin) : target;
    },

    resumePass: () =>
      mutating(async () => {
        const target = resumable();
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
        const state = passStateOf(pass);
        if (state !== 'interrupted') {
          return conflict(state === 'running' ? 'passRunning' : 'notInterrupted');
        }
        return commit(withLastPass(journal, { ...pass, accepted: true }), 'must');
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
        const backs = backsPassOf(journal);
        if (backs === null && rotate180) {
          return conflict('noBacksPass');
        }
        // Сравнение — после нормализации: состояние, которое приводится к записанному, правкой
        // не считается и отметку о сохранении не снимает.
        const normalized = withRebasedEdits(journal, { ...journal, edits }).edits;
        if (
          (backs?.rotate180 ?? false) === rotate180 &&
          JSON.stringify(journal.edits) === JSON.stringify(normalized)
        ) {
          return ok(undefined);
        }
        const passes = journal.passes.map((pass) =>
          pass === backs ? { ...pass, rotate180 } : pass,
        );
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
        if (survivingPassesOf(journal).length > 1) {
          return conflict('backsPresent');
        }
        if (journal.backsDeclined) {
          return ok(undefined);
        }
        // Вывод не меняется (оборотов и не было) — отметка о сохранении остаётся.
        return commit({ ...journal, backsDeclined: true }, 'must');
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
      const pass = locate(key);
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
      if (closing || locate(key) === null) {
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
