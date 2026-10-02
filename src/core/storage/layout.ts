import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

// Раскладка каталога данных и устойчивый ключ страницы (ADR 0004 с амендментом; план M1, KTD-15).
//
//   <корень данных>/
//     settings.json               настройки и запомненный сканер
//     unclosed-jobs.json          незакрытые задания сканера
//     session/                    текущая сессия — источник правды
//       session.json              журнал; путь и имя поля маркера версии заморожены навсегда
//       pages/
//         p01-s01-0001.jpg        ключ: проход, сегмент, номер в сегменте
//     session.closing-<id>/       закрываемая сессия, дочищается при запуске
//     derived/<id сессии>/thumbs/ производное: удаляется без потерь
//
// Ключ стоит в имени файла: сессию можно пересобрать по именам, даже если журнал потерян. Номера
// проходов и сегментов внутри сессии не переиспользуются — иначе файл отброшенного сегмента
// нельзя отличить от новой страницы.

export const MAX_PASS_NUMBER = 99;
export const MAX_SEGMENT_NUMBER = 99;
export const MAX_PAGE_INDEX = 9999;

export const JOURNAL_FILE_NAME = 'session.json';
export const PAGES_DIR_NAME = 'pages';

/** Имя файла страницы: ключ и расширение. Без флагов `g` и `y` — шаблон идёт в `removeByPrefix`. */
export const PAGE_FILE = /^p(\d{2})-s(\d{2})-(\d{4})\.jpg$/;
const PAGE_KEY = /^p(\d{2})-s(\d{2})-(\d{4})$/;

export const SESSION_ID = /^[0-9a-f]{16}$/;

/** Новый идентификатор сессии — подходит под `SESSION_ID`. */
export const newSessionId = (): string => randomBytes(8).toString('hex');
const CLOSING_DIR = /^session\.closing-[0-9a-f]{16}$/;

export interface DataLayout {
  readonly root: string;
  readonly settingsFile: string;
  readonly unclosedJobsFile: string;
  readonly sessionDir: string;
  readonly journalFile: string;
  readonly pagesDir: string;
  readonly derivedDir: string;
}

export function layoutOf(dataRoot: string): DataLayout {
  const sessionDir = join(dataRoot, 'session');
  return {
    root: dataRoot,
    settingsFile: join(dataRoot, 'settings.json'),
    unclosedJobsFile: join(dataRoot, 'unclosed-jobs.json'),
    sessionDir,
    journalFile: join(sessionDir, JOURNAL_FILE_NAME),
    pagesDir: join(sessionDir, PAGES_DIR_NAME),
    derivedDir: join(dataRoot, 'derived'),
  };
}

/** Каталог, в который переименовывается закрываемая сессия (KTD-33). */
export function closingDirOf(layout: DataLayout, sessionId: string): string {
  return join(layout.root, `session.closing-${sessionId}`);
}

export function isClosingDirName(name: string): boolean {
  return CLOSING_DIR.test(name);
}

/** Производный кэш сессии: лежит рядом с сессией, а не внутри неё (KTD-22). */
export function derivedDirOf(layout: DataLayout, sessionId: string): string {
  return join(layout.derivedDir, sessionId);
}

/** Каталог миниатюр сессии от корня производного кэша — для модуля, который знает только его. */
export function thumbsDirIn(derivedDir: string, sessionId: string): string {
  return join(derivedDir, sessionId, 'thumbs');
}

export function thumbsDirOf(layout: DataLayout, sessionId: string): string {
  return thumbsDirIn(layout.derivedDir, sessionId);
}

export interface PageAddress {
  readonly pass: number;
  readonly segment: number;
  /** Номер в сегменте, с единицы. */
  readonly index: number;
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/** Префикс ключей сегмента: `p01-s02-`. Дефис в конце не даёт `s01` совпасть с `s011`. */
export function segmentPrefix(pass: number, segment: number): string {
  return `p${pad(pass, 2)}-s${pad(segment, 2)}-`;
}

export function pageKey({ pass, segment, index }: PageAddress): string {
  return `${segmentPrefix(pass, segment)}${pad(index, 4)}`;
}

export function pageFileName(key: string): string {
  return `${key}.jpg`;
}

function addressOf(match: RegExpExecArray | null): PageAddress | null {
  if (match === null) {
    return null;
  }
  const [pass, segment, index] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // Нулевых номеров не бывает: счёт идёт с единицы.
  return pass >= 1 && segment >= 1 && index >= 1 ? { pass, segment, index } : null;
}

/** Ключ страницы по заякоренному шаблону; всё остальное — `null`. */
export function parsePageKey(key: string): PageAddress | null {
  return addressOf(PAGE_KEY.exec(key));
}

export function parsePageFileName(name: string): PageAddress | null {
  return addressOf(PAGE_FILE.exec(name));
}
