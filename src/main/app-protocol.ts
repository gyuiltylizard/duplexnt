import { resolve, sep } from 'node:path';

// Схема интерфейса (B-29, U1; ADR 0005 — амендмент): вне dev-сервера окно грузится с
// `duplexnt-app://app/index.html`, а не с `file://`. Отдаются только файлы каталога собранного
// renderer, только известных типов и только на `GET`; всё остальное — 404 без подробностей.
// Electron не импортируется: привилегии — чистый объект с литеральными типами, обработчик
// принимает WHATWG `Request` и отдаёт `Response`, чтение файла инъецируется (как в
// `page-protocol.ts`), поэтому контракт проверяется тестом под обычным Node.
//
// Минимум привилегий: только `standard` — иначе относительные адреса ассетов (`./assets/…`) и
// `'self'` в CSP не работают. `secure` не берём: безопасный контекст интерфейсу не нужен, а
// страница на «безопасной» схеме считала бы картинки `duplexnt-page` смешанным содержимым.
// Итог спайка на `out/` — в журнале 0035.

export const APP_SCHEME = 'duplexnt-app';
export const APP_HOST = 'app';
/** Адрес документа интерфейса; относительные адреса ассетов Vite считаются от него. */
export const APP_INDEX_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

export interface AppSchemePrivileges {
  readonly standard: true;
  readonly secure: false;
  readonly bypassCSP: false;
  readonly supportFetchAPI: false;
  readonly corsEnabled: false;
  readonly allowServiceWorkers: false;
  readonly stream: false;
  readonly codeCache: false;
}

export const APP_SCHEME_PRIVILEGES: AppSchemePrivileges = {
  standard: true,
  secure: false,
  bypassCSP: false,
  supportFetchAPI: false,
  corsEnabled: false,
  allowServiceWorkers: false,
  stream: false,
  codeCache: false,
};

/** Что регистрируется до `ready` одним вызовом вместе со схемой изображений. */
export const APP_SCHEME_REGISTRATION = {
  scheme: APP_SCHEME,
  privileges: APP_SCHEME_PRIVILEGES,
} as const;

/** Белый список типов — ровно то, что кладёт в `out/renderer` сборка Vite. */
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['html', 'text/html; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['woff2', 'font/woff2'],
  ['woff', 'font/woff'],
]);

/**
 * Сегмент пути: имя из букв, цифр, `_` и `-`, точки только внутри. Это отсекает `.` и `..`,
 * пустые сегменты, хвостовую точку или пробел (NTFS их отбрасывает), поток `::$DATA`, букву
 * диска с двоеточием и всё, чего Vite в имена не кладёт.
 */
const SEGMENT = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

export interface AppFile {
  readonly path: string;
  readonly contentType: string;
}

/**
 * Файл каталога renderer по адресу схемы; всё, что не ровно `duplexnt-app://app/<путь>` к
 * файлу известного типа внутри каталога, — `null`. Имена сборки — только ASCII без спецзнаков,
 * поэтому любое процентное кодирование в пути чужое и отклоняется целиком: `%2e%2e`, `%252e`,
 * `%2f`, `%00` и `%20` не раскодируются вовсе, а путь без `%` равен своему раскодированному виду,
 * и грамматика сегментов проверяет уже нормализованные имена.
 */
export function resolveAppFile(raw: string, rendererDir: string): AppFile | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== `${APP_SCHEME}:` ||
    url.hostname !== APP_HOST ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== ''
  ) {
    return null;
  }
  // Разборщик URL уже нормализовал путь: схлопнул `.` и `..`, снял хвостовые пробелы. Адрес без
  // пути (`duplexnt-app://app`) под Node даёт пустой путь, в Chromium — `/`; оба — документ.
  const pathname = url.pathname === '' || url.pathname === '/' ? '/index.html' : url.pathname;
  if (pathname.includes('%') || pathname.includes('\\')) {
    return null;
  }
  const [empty, ...segments] = pathname.split('/');
  if (
    empty !== '' ||
    segments.length === 0 ||
    !segments.every((segment) => SEGMENT.test(segment))
  ) {
    return null;
  }
  const name = segments[segments.length - 1] ?? '';
  const dot = name.lastIndexOf('.');
  if (dot < 0) {
    return null;
  }
  const contentType = CONTENT_TYPES.get(name.slice(dot + 1).toLowerCase());
  if (contentType === undefined) {
    return null;
  }
  // Грамматика сегментов уже не пускает наружу; проверка каталога — второй рубеж, и она
  // отличает `out/renderer/x` от соседнего `out/renderer-x` (разделитель после корня).
  const root = resolve(rendererDir);
  const path = resolve(root, ...segments);
  if (!path.startsWith(root + sep)) {
    return null;
  }
  return { path, contentType };
}

/** Откуда берутся байты: каталог собранного renderer и чтение файла по абсолютному пути. */
export interface AppFileSource {
  readonly rendererDir: string;
  readFile(path: string): Promise<Uint8Array>;
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

const notFound = (): Response => new Response(null, { status: 404, headers: NO_STORE });

/** Обработчик `protocol.handle`: только `GET`, только файлы каталога renderer. */
export async function handleAppRequest(
  request: { readonly method: string; readonly url: string },
  source: AppFileSource,
): Promise<Response> {
  if (request.method !== 'GET') {
    return notFound();
  }
  const file = resolveAppFile(request.url, source.rendererDir);
  if (file === null) {
    return notFound();
  }
  let bytes: Uint8Array;
  try {
    bytes = await source.readFile(file.path);
  } catch {
    // Отсутствующий файл и любая ошибка чтения снаружи неразличимы.
    return notFound();
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': file.contentType,
      'X-Content-Type-Options': 'nosniff',
      ...NO_STORE,
    },
  });
}
