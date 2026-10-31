import { isPageKey, isSessionId } from '@core/storage/layout';
import {
  isStraightView,
  PAGE_IMAGE_SCHEME,
  PAGE_IMAGE_VIEWS,
  type PageImageView,
  type Result,
} from '@shared';

// Схема изображений страниц (ADR 0005; план M1, U18, KTD-38; M6, U6, KTD-7). Адрес:
// `duplexnt-page://<сессия>/<вид>/<ключ>`, у выправленных видов — `<вид>/<версия>/<ключ>`.
// Electron не импортируется: привилегии — чистый объект с литеральными типами, как у настроек
// окна; обработчик принимает WHATWG `Request` и отдаёт `Response` — оба есть и под обычным
// Node, поэтому контракт ответа проверяется тестом.
//
// Минимум привилегий: только `standard` — чтобы адрес разбирался как `схема://хост/путь`.
// Всё, что дало бы странице новые возможности (fetch, CORS, service worker, обход CSP, потоки,
// кэш кода), выключено явно. Ответ всегда `image/jpeg`, `nosniff`, `no-store`; любой отказ — 404
// без подробностей: чужая сессия, неизвестный ключ и потерянная страница неразличимы снаружи.
// Выправленный вид без файла отдаёт оригинал / обычную миниатюру (KTD-7): истина для пометки —
// статус в снимке, а не ответ сервера; версия в адресе — только чтобы адрес менялся.

export interface PageSchemePrivileges {
  readonly standard: true;
  readonly secure: false;
  readonly bypassCSP: false;
  readonly supportFetchAPI: false;
  readonly corsEnabled: false;
  readonly allowServiceWorkers: false;
  readonly stream: false;
  readonly codeCache: false;
}

export const PAGE_SCHEME_PRIVILEGES: PageSchemePrivileges = {
  standard: true,
  secure: false,
  bypassCSP: false,
  supportFetchAPI: false,
  corsEnabled: false,
  allowServiceWorkers: false,
  stream: false,
  codeCache: false,
};

/** Что регистрируется до `ready`: `protocol.registerSchemesAsPrivileged([PAGE_SCHEME_REGISTRATION])`. */
export const PAGE_SCHEME_REGISTRATION = {
  scheme: PAGE_IMAGE_SCHEME,
  privileges: PAGE_SCHEME_PRIVILEGES,
} as const;

/** Откуда берутся байты: текущая сессия и чтение по ключу. Путь к файлу снаружи не виден. */
export interface PageImageSource {
  /** Идентификатор текущей сессии; `null` — сессии нет. */
  sessionId(): string | null;
  readPage(key: string): Promise<Result<Uint8Array>>;
  readThumbnail(key: string): Promise<Result<Uint8Array>>;
  /** Выправленная страница (M6, KTD-7); отказ — выправленного вида нет, идёт оригинал. */
  readStraight(key: string): Promise<Result<Uint8Array>>;
  /** Миниатюра выправленной; отказ — обычная миниатюра. */
  readStraightThumbnail(key: string): Promise<Result<Uint8Array>>;
}

// Ключ и идентификатор сессии проверяются грамматикой ядра (`isPageKey`, `isSessionId`) по сырому
// пути без раскодирования: `%2e%2e` и прочее кодирование не проходят, точечные сегменты разборщик
// URL схлопывает до того, как сюда попадает путь, и ключ тогда просто не совпадает.

interface PageAddress {
  readonly sessionId: string;
  readonly view: PageImageView;
  readonly key: string;
  /** Версии геометрии и детектора из адреса выправленного вида; у остальных `null`. */
  readonly version: number | null;
  readonly detector: number | null;
}

const isView = (value: string): value is PageImageView =>
  (PAGE_IMAGE_VIEWS as readonly string[]).includes(value);

/**
 * Версии в адресе: геометрия — целое от единицы, детектор — от нуля (запись прежнего формата);
 * без ведущих нулей, не длиннее четырёх цифр каждая, через точку.
 */
const VERSIONS = /^([1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;

/**
 * Разбор адреса; всё, что не ровно `схема://сессия/вид/ключ` (у выправленных видов —
 * `схема://сессия/вид/геометрия.детектор/ключ`), — `null`.
 */
export function parsePageImageUrl(raw: string): PageAddress | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== `${PAGE_IMAGE_SCHEME}:` ||
    url.search !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== ''
  ) {
    return null;
  }
  const segments = url.pathname.split('/');
  const [empty, view, ...rest] = segments;
  if (empty !== '' || view === undefined || !isView(view) || !isSessionId(url.hostname)) {
    return null;
  }
  let version: number | null = null;
  let detector: number | null = null;
  if (isStraightView(view)) {
    const match = VERSIONS.exec(rest.shift() ?? '');
    if (match === null) {
      return null;
    }
    version = Number(match[1]);
    detector = Number(match[2]);
  }
  const [key, ...extra] = rest;
  if (key === undefined || extra.length > 0 || !isPageKey(key)) {
    return null;
  }
  return { sessionId: url.hostname, view, key, version, detector };
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

const notFound = (): Response => new Response(null, { status: 404, headers: NO_STORE });

/** Байты вида; выправленный вид без файла — оригинал того же размера (KTD-7). */
async function readView(
  address: PageAddress,
  source: PageImageSource,
): Promise<Result<Uint8Array>> {
  switch (address.view) {
    case 'page':
      return source.readPage(address.key);
    case 'thumb':
      return source.readThumbnail(address.key);
    case 'straight': {
      const straight = await source.readStraight(address.key);
      return straight.ok ? straight : source.readPage(address.key);
    }
    case 'straight-thumb': {
      const straight = await source.readStraightThumbnail(address.key);
      return straight.ok ? straight : source.readThumbnail(address.key);
    }
  }
}

/** Обработчик `protocol.handle`: только `GET`, только страницы текущей сессии. */
export async function handlePageImageRequest(
  request: { readonly method: string; readonly url: string },
  source: PageImageSource,
): Promise<Response> {
  if (request.method !== 'GET') {
    return notFound();
  }
  const address = parsePageImageUrl(request.url);
  if (address === null) {
    return notFound();
  }
  // Сессии нет или адрес прошлой сессии — тот же 404.
  if (address.sessionId !== source.sessionId()) {
    return notFound();
  }
  const image = await readView(address, source);
  if (!image.ok) {
    return notFound();
  }
  // Копия в собственный буфер: `Response` не должен держать память хранилища или кэша.
  return new Response(new Uint8Array(image.value), {
    status: 200,
    headers: {
      'Content-Type': 'image/jpeg',
      'X-Content-Type-Options': 'nosniff',
      ...NO_STORE,
    },
  });
}
