import { join } from 'node:path';
import type { StartupNotice } from '@shared';
import { isTempName, removeByPrefix, writeFileAtomic } from './atomic-file';
import {
  JOURNAL_VERSION,
  journalSchema,
  newJournal,
  pageCountOf,
  pagesOf,
  parseJournal,
  type Journal,
  type JournalPass,
  type JournalSegment,
} from './journal';
import {
  isClosingDirName,
  layoutOf,
  newSessionId as randomSessionId,
  PAGE_FILE,
  parsePageFileName,
  segmentPrefix,
  thumbsDirOf,
} from './layout';
import {
  createSessionStore,
  NO_SESSION,
  sweepClosedSession,
  type SessionState,
  type SessionStore,
  type SessionStoreOptions,
} from './session-store';
import { ioOf, isMissing, listDir } from './storage-fs';
import { readVersionMarker, setAside, setAsidePathOf, writeVersioned } from './versioned-file';

// Сверка при запуске (план M1, U14; ADR 0004): журнал сверяется с файлами по таблице плана.
// Строки применяются сверху вниз; несовместимые данные отменяют все остальные — в каталоге тогда
// не меняется ни байта. Сверка идемпотентна: повторный прогон того же каталога ничего не меняет.
//
// | Найдено                                             | Действие                                |
// | каталога сессии нет                                 | сессии нет                              |
// | маркер версии новее понятного                       | ничего не трогается; режим отказа       |
// | `session.closing-*`                                 | очистка доводится до конца              |
// | журнал не читается                                  | отодвигается, сессия — по ключам файлов |
// | журнала нет, страниц нет                            | каталог убирается                       |
// | пометка об удалении сегмента                        | удаление доводится до конца             |
// | временный файл страницы или журнала                 | удаляется                               |
// | страница без записи                                 | возвращается в свой сегмент по ключу    |
// | страница, у прохода или сегмента которой нет записи | проход и сегмент создаются прерванными  |
// | запись без файла или файл нулевой длины             | страница потеряна, место сохраняется    |
// | сегмент «идёт»                                      | прерван                                 |
// | ни файлов страниц, ни записей о страницах           | каталог убирается                       |
// | производный кэш чужой сессии                        | удаляется                               |
//
// Незакрытое задание сканера закрывает служба прохода перед следующим `POST`; его файл сверка не
// трогает.

export interface ReconcileOutcome {
  readonly state: SessionState;
  /** О чём интерфейс сообщает пользователю после запуска. */
  readonly notices: readonly StartupNotice[];
}

/** Что лежит в каталоге страниц под одним префиксом сегмента. */
interface SegmentFiles {
  readonly pass: number;
  readonly segment: number;
  /** Номера страниц, у которых есть непустой файл. */
  readonly present: Set<number>;
  /** Имена файлов нулевой длины: страницами не считаются. */
  readonly empty: string[];
}

const attempt = <T>(action: Promise<T>): Promise<T | undefined> => action.catch(() => undefined);

const interruptedSegment = (number: number, pageCount: number): JournalSegment => ({
  number,
  state: 'interrupted',
  pageCount,
});

// Вставка по возрастанию номера: порядок сегментов в журнале — порядок получения страниц.
function inserted<T extends { readonly number: number }>(items: readonly T[], item: T): T[] {
  return [...items, item].sort((left, right) => left.number - right.number);
}

/**
 * Возвращает найденные файлы в журнал. Страница без записи попадает в свой сегмент по ключу;
 * сегмент или проход, которых в журнале нет, создаются прерванными — у созданного прохода нет ни
 * сканера, ни параметров. Пропуск в нумерации становится записью без файла: потерянной страницей.
 * Сегмент «идёт» становится прерванным.
 */
function adopt(
  journal: Journal,
  files: readonly SegmentFiles[],
  /** Префиксы под пометкой об удалении на момент запуска: их файлы обратно не принимаются. */
  marked: readonly string[],
): Journal {
  let { passes, nextPass } = journal;

  for (const group of files) {
    const found = Math.max(0, ...group.present);
    if (found === 0 || marked.includes(segmentPrefix(group.pass, group.segment))) {
      continue;
    }
    const pass = passes.find((it) => it.number === group.pass);
    if (pass === undefined) {
      const created: JournalPass = {
        number: group.pass,
        accepted: false,
        origin: null,
        nextSegment: group.segment + 1,
        segments: [interruptedSegment(group.segment, found)],
        rotate180: false,
      };
      passes = inserted(passes, created);
      nextPass = Math.max(nextPass, group.pass + 1);
      continue;
    }
    const segment = pass.segments.find((it) => it.number === group.segment);
    const segments =
      segment === undefined
        ? inserted(pass.segments, interruptedSegment(group.segment, found))
        : pass.segments.map((it) =>
            it === segment && found > it.pageCount ? { ...it, pageCount: found } : it,
          );
    const nextSegment = Math.max(pass.nextSegment, group.segment + 1);
    passes = passes.map((it) => (it === pass ? { ...pass, segments, nextSegment } : it));
  }

  passes = passes.map((pass) => ({
    ...pass,
    segments: pass.segments.map((segment) =>
      segment.state === 'running' ? { ...segment, state: 'interrupted' as const } : segment,
    ),
  }));
  return { ...journal, passes, nextPass };
}

export async function reconcileSession(
  dataRoot: string,
  options: SessionStoreOptions = {},
): Promise<ReconcileOutcome> {
  const layout = layoutOf(dataRoot);
  const io = ioOf(options);
  const { fs } = io;
  const newSessionId = options.newSessionId ?? randomSessionId;

  // Журнал читается первым: данные более новой версии отменяют всё остальное (KTD-35).
  let original: Uint8Array | null = null;
  try {
    original = await fs.readFile(layout.journalFile);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
  const read = original === null ? null : parseJournal(original);
  if (read?.kind === 'incompatible') {
    return { state: { ...NO_SESSION, incompatible: true }, notices: [] };
  }

  for (const name of await listDir(fs, layout.root)) {
    if (isClosingDirName(name)) {
      await sweepClosedSession(fs, join(layout.root, name));
    }
  }

  const dropForeignCaches = async (sessionId: string | null): Promise<void> => {
    for (const name of (await attempt(listDir(fs, layout.derivedDir))) ?? []) {
      if (name !== sessionId) {
        await attempt(fs.removeTree(join(layout.derivedDir, name)));
      }
    }
  };

  let sessionNames: string[];
  try {
    sessionNames = await fs.readdir(layout.sessionDir);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    await dropForeignCaches(null);
    return { state: NO_SESSION, notices: [] };
  }

  // Временные файлы — недописанное: страницей и журналом не считаются.
  for (const name of sessionNames.filter(isTempName)) {
    await attempt(fs.unlink(join(layout.sessionDir, name)));
  }
  const groups = new Map<string, SegmentFiles>();
  for (const name of await listDir(fs, layout.pagesDir)) {
    if (isTempName(name)) {
      await attempt(fs.unlink(join(layout.pagesDir, name)));
      continue;
    }
    const address = parsePageFileName(name);
    if (address === null) {
      continue;
    }
    const prefix = segmentPrefix(address.pass, address.segment);
    const group = groups.get(prefix) ?? { ...address, present: new Set<number>(), empty: [] };
    groups.set(prefix, group);
    // Размер не узнать — файл считается страницей: потерянной её объявит чтение, а не догадка.
    const size = (await attempt(fs.size(join(layout.pagesDir, name)))) ?? 1;
    if (size > 0) {
      group.present.add(address.index);
    } else {
      group.empty.push(name);
    }
  }

  const notices: StartupNotice[] = [];
  let journal = read?.kind === 'ok' ? read.value : null;
  // Журнал, который нельзя сохранить в стороне, сверка не затирает: новый остаётся в памяти, а
  // хранилище отодвигает прежний файл перед своей первой записью — или не пишет вовсе.
  let writable = true;
  if (journal === null) {
    if (original !== null) {
      // Нечитаемый журнал не удаляется (KTD-34): отодвигается, а не выйдет — копируется.
      writable =
        (await attempt(setAside(layout.journalFile, io).then(() => true))) ??
        (await attempt(
          writeFileAtomic(setAsidePathOf(layout.journalFile), original, io).then(() => true),
        )) ??
        false;
    }
    if ([...groups.values()].some((group) => group.present.size > 0)) {
      journal = newJournal(newSessionId());
      notices.push('journalRebuilt');
    }
  }
  // Журнал прежней версии разбирается в текущую и обязан быть переписан, даже когда сверке
  // нечего менять (запись — всегда текущей версией): маркер на диске сверяется отдельно.
  const diskVersion = original === null ? null : readVersionMarker(original);
  const before =
    diskVersion === JOURNAL_VERSION && read?.kind === 'ok' ? JSON.stringify(read.value) : null;

  if (journal !== null) {
    // Начатое удаление доводится до конца; файлы под пометкой обратно не принимаются. Пометка
    // снимается, когда под префиксом не осталось ни одного файла.
    const deletions: string[] = [];
    for (const prefix of journal.deletions) {
      const report = await attempt(removeByPrefix(layout.pagesDir, prefix, PAGE_FILE, io));
      await attempt(removeByPrefix(thumbsDirOf(layout, journal.sessionId), prefix, PAGE_FILE, io));
      if (report === undefined || report.failed.length > 0) {
        deletions.push(prefix);
      }
    }
    const cleaned = { ...journal, deletions };
    const adopted = adopt(cleaned, [...groups.values()], journal.deletions);
    // Усыновление изменило проходы (файлы сверх записей — после сбоя записи журнала): набор
    // больше не соответствует сохранённому PDF, отметка о сохранении снимается (R12).
    journal =
      adopted.saved && JSON.stringify(adopted.passes) !== JSON.stringify(cleaned.passes)
        ? { ...adopted, saved: false }
        : adopted;
  }

  // Пустая сессия равна отсутствию сессии (ADR 0004, амендмент). Журнал с пометкой остаётся:
  // без него неудалённые файлы отброшенного сегмента вернулись бы страницами.
  if (journal === null || (pageCountOf(journal) === 0 && journal.deletions.length === 0)) {
    for (const group of groups.values()) {
      for (const name of group.empty) {
        await attempt(fs.unlink(join(layout.pagesDir, name)));
      }
    }
    await attempt(fs.rmdir(layout.pagesDir));
    if (journal !== null) {
      await attempt(fs.unlink(layout.journalFile));
    }
    await attempt(fs.rmdir(layout.sessionDir));
    await dropForeignCaches(null);
    return { state: { ...NO_SESSION, unpreserved: !writable }, notices: [] };
  }

  const lost = new Set<string>();
  for (const pass of journal.passes) {
    for (const page of pagesOf(pass)) {
      const group = groups.get(segmentPrefix(page.pass, page.segment));
      if (group?.present.has(page.index) !== true) {
        lost.add(page.key);
      }
    }
  }
  if (lost.size > 0) {
    notices.push('pagesLost');
  }

  let unsaved = false;
  if (JSON.stringify(journal) !== before) {
    // Запись начинается, только когда прежний файл сохранён в стороне.
    const write = (): Promise<void> =>
      writeVersioned(layout.journalFile, journalSchema, JOURNAL_VERSION, journal, io);
    unsaved = !writable || (await attempt(write().then(() => false))) !== false;
  }

  await dropForeignCaches(journal.sessionId);
  return {
    state: { incompatible: false, journal, lost, unsaved, unpreserved: !writable },
    notices,
  };
}

/** Сверка и хранилище, открытое на её результате. */
export async function openSessionStore(
  dataRoot: string,
  options: SessionStoreOptions = {},
): Promise<{ readonly store: SessionStore; readonly notices: readonly StartupNotice[] }> {
  const { state, notices } = await reconcileSession(dataRoot, options);
  return { store: createSessionStore(dataRoot, state, options), notices };
}
