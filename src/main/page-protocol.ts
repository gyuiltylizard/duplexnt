import { PAGE_IMAGE_SCHEME, PAGE_IMAGE_VIEWS, type PageImageView, type Result } from '@shared';

// Схема изображений страниц (ADR 0005; план M1, U18, KTD-38). Адрес:
// `duplexnt-page://<сессия>/<вид>/<ключ>`. Electron не импортируется: привилегии — чистый объект с
// литеральными типами, как у настроек окна; обработчик принимает WHATWG `Request` и отдаёт
// `Response` — оба есть и под обычным Node, поэтому контракт ответа проверяется тестом.
//
// Минимум привилегий: только `standard` — чтобы адрес разбирался как `схема://хост/путь`.
// Всё, что дало бы странице новые возможности (fetch, CORS, service worker, обход CSP, потоки,
// кэш кода), выключено явно. Ответ всегда `image/jpeg`, `nosniff`, `no-store`; любой отказ — 404
// без подробностей: чужая сессия, неизвестный ключ и потерянная страница неразличимы снаружи.

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
}

// Ключ и идентификатор сессии — заякоренные шаблоны по сырому пути без раскодирования: `%2e%2e`
// и прочее кодирование не проходят, точечные сегменты разборщик URL схлопывает до того, как
// сюда попадает путь, и ключ тогда просто не совпадает.
const PAGE_KEY = /^p\d{2}-s\d{2}-\d{4}$/;
const SESSION_ID = /^[0-9a-f]{16}$/;

interface PageAddress {
  readonly sessionId: string;
  readonly view: PageImageView;
  readonly key: string;
}

const isView = (value: string): value is PageImageView =>
  (PAGE_IMAGE_VIEWS as readonly string[]).includes(value);

/** Разбор адреса; всё, что не ровно `схема://сессия/вид/ключ`, — `null`. */
export function parsePageImageUrl(raw: string): PageAddress | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${PAGE_IMAGE_SCHEME}:` || url.search !== '' || url.username !== '') {
    return null;
  }
  const segments = url.pathname.split('/');
  const [empty, view, key, ...rest] = segments;
  if (empty !== '' || view === undefined || key === undefined || rest.length > 0) {
    return null;
  }
  if (!SESSION_ID.test(url.hostname) || !isView(view) || !PAGE_KEY.test(key)) {
    return null;
  }
  return { sessionId: url.hostname, view, key };
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

const notFound = (): Response => new Response(null, { status: 404, headers: NO_STORE });

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
  const image =
    address.view === 'thumb'
      ? await source.readThumbnail(address.key)
      : await source.readPage(address.key);
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
