import { fail, ok, pageImageUrl, type Result } from '@shared';
import { describe, expect, it, vi } from 'vitest';
import {
  handlePageImageRequest,
  PAGE_SCHEME_PRIVILEGES,
  PAGE_SCHEME_REGISTRATION,
  parsePageImageUrl,
  type PageImageSource,
} from './page-protocol';

// Схема изображений страниц (план M1, U18, KTD-38): привилегии — минимум, контракт ответа —
// `image/jpeg`, `nosniff`, `no-store`; всё, что не ровно адрес страницы текущей сессии, — 404.

const SESSION = '0123456789abcdef';
const OTHER_SESSION = 'fedcba9876543210';
const PAGE = Uint8Array.of(0xff, 0xd8, 1, 0xff, 0xd9);
const THUMB = Uint8Array.of(0xff, 0xd8, 2, 0xff, 0xd9);

function source(sessionId: string | null = SESSION) {
  const readPage = vi.fn((key: string): Promise<Result<Uint8Array>> =>
    Promise.resolve(
      key === 'p01-s01-0001'
        ? ok(PAGE)
        : key === 'p01-s01-0002'
          ? fail('pageUnavailable', { reason: 'lost' })
          : fail('pageUnavailable', { reason: 'unknown' }),
    ),
  );
  const readThumbnail = vi.fn((key: string): Promise<Result<Uint8Array>> =>
    Promise.resolve(key === 'p01-s01-0001' ? ok(THUMB) : fail('thumbnailFailed')),
  );
  const pages: PageImageSource = { sessionId: () => sessionId, readPage, readThumbnail };
  return { pages, readPage, readThumbnail };
}

const get = (url: string, pages = source().pages) =>
  handlePageImageRequest({ method: 'GET', url }, pages);

describe('привилегии схемы', () => {
  it('включён только standard; остальное выключено явно', () => {
    expect(PAGE_SCHEME_PRIVILEGES).toEqual({
      standard: true,
      secure: false,
      bypassCSP: false,
      supportFetchAPI: false,
      corsEnabled: false,
      allowServiceWorkers: false,
      stream: false,
      codeCache: false,
    });
    expect(PAGE_SCHEME_REGISTRATION.scheme).toBe('duplexnt-page');
  });
});

describe('parsePageImageUrl', () => {
  it('разбирает адрес, собранный помощником контракта', () => {
    expect(parsePageImageUrl(pageImageUrl(SESSION, 'page', 'p01-s01-0001'))).toEqual({
      sessionId: SESSION,
      view: 'page',
      key: 'p01-s01-0001',
    });
    expect(parsePageImageUrl(pageImageUrl(SESSION, 'thumb', 'p02-s03-9999'))?.view).toBe('thumb');
  });

  it.each([
    ['чужая схема', `https://${SESSION}/page/p01-s01-0001`],
    ['без сессии', 'duplexnt-page:///page/p01-s01-0001'],
    ['сессия не по шаблону', 'duplexnt-page://session/page/p01-s01-0001'],
    ['неизвестный вид', `duplexnt-page://${SESSION}/raw/p01-s01-0001`],
    ['лишний сегмент', `duplexnt-page://${SESSION}/page/p01-s01-0001/x`],
    ['не хватает сегмента', `duplexnt-page://${SESSION}/page`],
    ['строка запроса', `duplexnt-page://${SESSION}/page/p01-s01-0001?x=1`],
    ['имя файла вместо ключа', `duplexnt-page://${SESSION}/page/p01-s01-0001.jpg`],
    ['обход каталога', `duplexnt-page://${SESSION}/page/../../session.json`],
    ['закодированный обход', `duplexnt-page://${SESSION}/page/%2e%2e%2fsession.json`],
    ['закодированный слэш в ключе', `duplexnt-page://${SESSION}/page%2fp01-s01-0001`],
    ['userinfo', `duplexnt-page://user@${SESSION}/page/p01-s01-0001`],
    ['пароль в userinfo', `duplexnt-page://:pw@${SESSION}/page/p01-s01-0001`],
    ['явный порт', `duplexnt-page://${SESSION}:80/page/p01-s01-0001`],
    ['нулевой номер страницы', `duplexnt-page://${SESSION}/page/p01-s01-0000`],
    ['не URL', 'не url'],
  ])('отклоняет: %s', (_name, url) => {
    expect(parsePageImageUrl(url)).toBeNull();
  });
});

describe('handlePageImageRequest', () => {
  it('страница: 200, image/jpeg, nosniff, no-store, байты как есть', async () => {
    const response = await get(pageImageUrl(SESSION, 'page', 'p01-s01-0001'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PAGE);
  });

  it('миниатюра берётся из своего источника с теми же заголовками', async () => {
    const { pages, readPage, readThumbnail } = source();

    const response = await get(pageImageUrl(SESSION, 'thumb', 'p01-s01-0001'), pages);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(THUMB);
    expect(readThumbnail).toHaveBeenCalledExactlyOnceWith('p01-s01-0001');
    expect(readPage).not.toHaveBeenCalled();
  });

  it('не GET — 404 без обращения к источнику', async () => {
    const { pages, readPage } = source();
    for (const method of ['POST', 'HEAD', 'DELETE', 'OPTIONS']) {
      const response = await handlePageImageRequest(
        { method, url: pageImageUrl(SESSION, 'page', 'p01-s01-0001') },
        pages,
      );
      expect(response.status, method).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(readPage).not.toHaveBeenCalled();
  });

  it('негодный адрес — 404 без обращения к источнику', async () => {
    const { pages, readPage, readThumbnail } = source();
    for (const url of [
      `duplexnt-page://${SESSION}/page/../../session.json`,
      `duplexnt-page://${SESSION}/page/p01-s01-0001?x=1`,
      `duplexnt-page://${SESSION}/page/p01-s01-0001/extra`,
    ]) {
      expect((await get(url, pages)).status, url).toBe(404);
    }
    expect(readPage).not.toHaveBeenCalled();
    expect(readThumbnail).not.toHaveBeenCalled();
  });

  it('неизвестный ключ, потерянная страница и не построившаяся миниатюра — 404', async () => {
    expect((await get(pageImageUrl(SESSION, 'page', 'p09-s09-0009'))).status).toBe(404);
    expect((await get(pageImageUrl(SESSION, 'page', 'p01-s01-0002'))).status).toBe(404);
    expect((await get(pageImageUrl(SESSION, 'thumb', 'p01-s01-0002'))).status).toBe(404);
  });

  it('адрес прошлой сессии и адрес без сессии — 404 без обращения к источнику', async () => {
    const current = source();
    const none = source(null);

    expect(
      (await get(pageImageUrl(OTHER_SESSION, 'page', 'p01-s01-0001'), current.pages)).status,
    ).toBe(404);
    expect((await get(pageImageUrl(SESSION, 'page', 'p01-s01-0001'), none.pages)).status).toBe(404);
    expect(current.readPage).not.toHaveBeenCalled();
    expect(none.readPage).not.toHaveBeenCalled();
  });

  it('ответ не делит память с источником', async () => {
    const bytes = Uint8Array.of(0xff, 0xd8, 7, 0xff, 0xd9);
    const pages: PageImageSource = {
      sessionId: () => SESSION,
      readPage: () => Promise.resolve(ok(bytes)),
      readThumbnail: () => Promise.resolve(fail('thumbnailFailed')),
    };

    const response = await get(pageImageUrl(SESSION, 'page', 'p01-s01-0001'), pages);
    bytes.fill(0);

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      Uint8Array.of(0xff, 0xd8, 7, 0xff, 0xd9),
    );
  });
});
