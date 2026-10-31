import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

// Раскладка каталога данных и устойчивый ключ страницы (ADR 0004 с амендментом; план M1, KTD-15).
//
//   <корень данных>/
//     settings.json               настройки и запомненный сканер
//     unclosed-jobs.json          незакрытые задания сканера
//     window.json                 размер и положение окна (B-3): удобство, не данные
//     session/                    текущая сессия — источник правды
//       session.json              журнал; путь и имя поля маркера версии заморожены навсегда
//       pages/
//         p01-s01-0001.jpg        ключ: проход, сегмент, номер в сегменте
//     session.closing-<id>/       закрываемая сессия, дочищается при запуске
//     derived/<id сессии>/thumbs/ производное: удаляется без потерь
//     derived/<id сессии>/blank/  оценки детектора пустых страниц (M4): тоже производное
//     derived/<id сессии>/skew/   оценки перекоса подачи (M6, KTD-11): `<ключ>.json`
//     derived/<id сессии>/straight/        выправленные страницы: `<ключ>.v<G>.d<D>.jpg` и запись
//                                          о коррекции `<ключ>.v<G>.d<D>.json`, G — версия
//                                          геометрии, D — детектора (B-19); прежний формат
//                                          `<ключ>.v<G>.*` без детектора читается и чистится
//     derived/<id сессии>/straight-thumbs/ миниатюры выправленных: тем же именем, что JPEG
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
/** Имя файла оценки пустой страницы: ключ и `.json` (M4, KTD3). */
export const BLANK_FILE = /^p(\d{2})-s(\d{2})-(\d{4})\.json$/;
/** Имя файла оценки перекоса: ключ и `.json` (M6, KTD-11) — та же форма, другой каталог. */
export const SKEW_FILE = /^p(\d{2})-s(\d{2})-(\d{4})\.json$/;
/**
 * Файлы выправленной страницы (M6, KTD-11; B-19): JPEG и запись о коррекции с версиями геометрии
 * и детектора в имени — пары разных версий сосуществуют, пока пересчёт не запишет новую. Прежний
 * формат без `.d<D>` (до B-19) принимается: такие пары читаются и чистятся по тем же правилам.
 */
export const STRAIGHT_FILE = /^p(\d{2})-s(\d{2})-(\d{4})\.v(\d+)(?:\.d(\d+))?\.(?:jpg|json)$/;
/** Миниатюра выправленной страницы: имя её JPEG — ключ, версии, `.jpg`. */
export const STRAIGHT_THUMB_FILE = /^p(\d{2})-s(\d{2})-(\d{4})\.v(\d+)(?:\.d(\d+))?\.jpg$/;
const PAGE_KEY = /^p(\d{2})-s(\d{2})-(\d{4})$/;

export const SESSION_ID = /^[0-9a-f]{16}$/;

/** Новый идентификатор сессии — подходит под `SESSION_ID`. */
export const newSessionId = (): string => randomBytes(8).toString('hex');
const CLOSING_DIR = /^session\.closing-[0-9a-f]{16}$/;

export interface DataLayout {
  readonly root: string;
  readonly settingsFile: string;
  readonly unclosedJobsFile: string;
  readonly windowFile: string;
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
    windowFile: join(dataRoot, 'window.json'),
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

/** Каталог оценок пустых страниц сессии от корня производного кэша (M4, KTD3). */
export function blankDirIn(derivedDir: string, sessionId: string): string {
  return join(derivedDir, sessionId, 'blank');
}

export function blankDirOf(layout: DataLayout, sessionId: string): string {
  return blankDirIn(layout.derivedDir, sessionId);
}

/** Каталог оценок перекоса сессии от корня производного кэша (M6, KTD-11). */
export function skewDirIn(derivedDir: string, sessionId: string): string {
  return join(derivedDir, sessionId, 'skew');
}

export function skewDirOf(layout: DataLayout, sessionId: string): string {
  return skewDirIn(layout.derivedDir, sessionId);
}

/**
 * Каталог выправленных страниц сессии (M6, KTD-11). Путь к файлу всем потребителям отдаёт
 * только `straightened.resolve` — страж `test/guards/straight-paths.test.ts` запрещает вызов
 * вне модуля выправленных файлов и путей очистки.
 */
export function straightDirIn(derivedDir: string, sessionId: string): string {
  return join(derivedDir, sessionId, 'straight');
}

export function straightDirOf(layout: DataLayout, sessionId: string): string {
  return straightDirIn(layout.derivedDir, sessionId);
}

/** Каталог миниатюр выправленных страниц сессии (M6, KTD-7). */
export function straightThumbsDirIn(derivedDir: string, sessionId: string): string {
  return join(derivedDir, sessionId, 'straight-thumbs');
}

export function straightThumbsDirOf(layout: DataLayout, sessionId: string): string {
  return straightThumbsDirIn(layout.derivedDir, sessionId);
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

export function blankFileName(key: string): string {
  return `${key}.json`;
}

export function skewFileName(key: string): string {
  return `${key}.json`;
}

/**
 * Детектор «неизвестен» (B-19): пара прежнего формата без `.d<D>` и запись без поля. Никогда не
 * равен версии детектора — такая пара годна для показа, но не для пропуска очереди.
 */
export const UNKNOWN_DETECTOR = 0;

/** Версии выправленной пары: геометрии и детектора (B-19). */
export interface StraightVersions {
  readonly version: number;
  readonly detector: number;
}

/** Основа имени пары: у детектора «неизвестен» — прежний формат без `.d<D>`. */
const straightStem = (key: string, version: number, detector: number): string =>
  detector === UNKNOWN_DETECTOR ? `${key}.v${version}` : `${key}.v${version}.d${detector}`;

/** Имя выправленного JPEG: ключ, версия геометрии и детектора (M6, KTD-11; B-19). */
export function straightFileName(key: string, version: number, detector: number): string {
  return `${straightStem(key, version, detector)}.jpg`;
}

/** Имя записи о коррекции рядом с JPEG тех же версий. */
export function straightRecordName(key: string, version: number, detector: number): string {
  return `${straightStem(key, version, detector)}.json`;
}

/**
 * Ключ и версии из имени файла выправленной страницы или её записи; иначе `null`. Без `.d<D>` —
 * детектор «неизвестен»; явный `.d0` — не имя пары.
 */
export function parseStraightFileName(
  name: string,
): ({ readonly key: string } & StraightVersions) | null {
  const match = STRAIGHT_FILE.exec(name);
  const address = addressOf(match);
  if (match === null || address === null) {
    return null;
  }
  const version = Number(match[4]);
  const detector = match[5] === undefined ? UNKNOWN_DETECTOR : Number(match[5]);
  return version >= 1 && (match[5] === undefined || detector >= 1)
    ? { key: pageKey(address), version, detector }
    : null;
}

function addressOf(match: RegExpExecArray | null): PageAddress | null {
  if (match === null) {
    return null;
  }
  const [pass, segment, index] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // Нулевых номеров не бывает: счёт идёт с единицы.
  return pass >= 1 && segment >= 1 && index >= 1 ? { pass, segment, index } : null;
}

/** Ключ страницы — ровно по шаблону, без нулевых номеров. Одна грамматика на ядро и схему изображений. */
export const isPageKey = (value: string): boolean => parsePageKey(value) !== null;

export const isSessionId = (value: string): boolean => SESSION_ID.test(value);

/** Ключ страницы по заякоренному шаблону; всё остальное — `null`. */
export function parsePageKey(key: string): PageAddress | null {
  return addressOf(PAGE_KEY.exec(key));
}

export function parsePageFileName(name: string): PageAddress | null {
  return addressOf(PAGE_FILE.exec(name));
}
