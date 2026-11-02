import { join, resolve, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  APP_INDEX_URL,
  APP_SCHEME_PRIVILEGES,
  APP_SCHEME_REGISTRATION,
  handleAppRequest,
  resolveAppFile,
  type AppFileSource,
} from './app-protocol';
import { PAGE_SCHEME_PRIVILEGES, PAGE_SCHEME_REGISTRATION } from './page-protocol';

// Схема интерфейса (B-29, U1): привилегии — только `standard`, отдаются только файлы каталога
// renderer известных типов и только на `GET`; всё остальное — 404 без обращения к файлам.

// `resolve` даёт абсолютный путь с буквой диска на Windows — ровно как внутри модуля.
const ROOT = resolve('/app/out/renderer');
const INDEX = Uint8Array.of(0x3c, 0x21, 0x64, 0x6f);

function source(files: Readonly<Record<string, Uint8Array>> = { 'index.html': INDEX }) {
  const readFile = vi.fn((path: string): Promise<Uint8Array> => {
    for (const [name, bytes] of Object.entries(files)) {
      if (path === join(ROOT, ...name.split('/'))) {
        return Promise.resolve(bytes);
      }
    }
    return Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }));
  });
  const app: AppFileSource = { rendererDir: ROOT, readFile };
  return { app, readFile };
}

const get = (url: string, app = source().app) => handleAppRequest({ method: 'GET', url }, app);

describe('привилегии схем', () => {
  it('у схемы интерфейса включён только standard; остальное выключено явно', () => {
    expect(APP_SCHEME_PRIVILEGES).toEqual({
      standard: true,
      secure: false,
      bypassCSP: false,
      supportFetchAPI: false,
      corsEnabled: false,
      allowServiceWorkers: false,
      stream: false,
      codeCache: false,
    });
    expect(APP_SCHEME_REGISTRATION).toEqual({
      scheme: 'duplexnt-app',
      privileges: APP_SCHEME_PRIVILEGES,
    });
    expect(APP_INDEX_URL).toBe('duplexnt-app://app/index.html');
  });

  it('привилегии схемы изображений не изменились (ADR 0005)', () => {
    expect(PAGE_SCHEME_REGISTRATION.scheme).toBe('duplexnt-page');
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
  });
});

describe('resolveAppFile', () => {
  it.each([
    ['документ', APP_INDEX_URL, 'index.html', 'text/html; charset=utf-8'],
    ['корень', 'duplexnt-app://app/', 'index.html', 'text/html; charset=utf-8'],
    ['адрес без пути', 'duplexnt-app://app', 'index.html', 'text/html; charset=utf-8'],
    [
      'скрипт',
      'duplexnt-app://app/assets/index-Ds9l4Mit.js',
      'assets/index-Ds9l4Mit.js',
      'text/javascript; charset=utf-8',
    ],
    [
      'стили',
      'duplexnt-app://app/assets/index-DmMg5Tu9.css',
      'assets/index-DmMg5Tu9.css',
      'text/css; charset=utf-8',
    ],
    [
      'woff2',
      'duplexnt-app://app/assets/golos-text-latin-400-normal-Coi1FYaD.woff2',
      'assets/golos-text-latin-400-normal-Coi1FYaD.woff2',
      'font/woff2',
    ],
    [
      'woff',
      'duplexnt-app://app/assets/golos-text-latin-400-normal-DOuJOmdK.woff',
      'assets/golos-text-latin-400-normal-DOuJOmdK.woff',
      'font/woff',
    ],
    [
      'якорь не доходит до обработчика, но безвреден',
      'duplexnt-app://app/index.html#x',
      'index.html',
      'text/html; charset=utf-8',
    ],
    [
      'точечный сегмент схлопывает разборщик URL',
      'duplexnt-app://app/./index.html',
      'index.html',
      'text/html; charset=utf-8',
    ],
    [
      'хвостовой пробел снимает разборщик URL',
      'duplexnt-app://app/index.html ',
      'index.html',
      'text/html; charset=utf-8',
    ],
  ])('отдаёт файл каталога: %s', (_name, url, relative, contentType) => {
    expect(resolveAppFile(url, ROOT)).toEqual({
      path: join(ROOT, ...relative.split('/')),
      contentType,
    });
  });

  it.each([
    ['чужая схема', 'file:///app/out/renderer/index.html'],
    ['схема изображений', 'duplexnt-page://app/index.html'],
    ['чужой хост', 'duplexnt-app://other/index.html'],
    ['без хоста', 'duplexnt-app:///index.html'],
    ['userinfo', 'duplexnt-app://user@app/index.html'],
    ['пароль в userinfo', 'duplexnt-app://:pw@app/index.html'],
    ['явный порт', 'duplexnt-app://app:80/index.html'],
    ['строка запроса', 'duplexnt-app://app/index.html?x=1'],
    ['неизвестное расширение', 'duplexnt-app://app/assets/index-Ds9l4Mit.js.map'],
    ['текстовый файл', 'duplexnt-app://app/nope.txt'],
    ['без расширения', 'duplexnt-app://app/html'],
    ['каталог', 'duplexnt-app://app/assets/'],
    ['пустой сегмент', 'duplexnt-app://app//index.html'],
    ['обход каталога', 'duplexnt-app://app/assets/../../package.json'],
    ['закодированный обход', 'duplexnt-app://app/%2e%2e/package.json'],
    ['дважды закодированный обход', 'duplexnt-app://app/%252e%252e/package.json'],
    ['закодированный слэш', 'duplexnt-app://app/assets%2Findex-Ds9l4Mit.js'],
    ['нулевой байт', 'duplexnt-app://app/index.html%00.js'],
    ['закодированный пробел', 'duplexnt-app://app/index.html%20'],
    ['обратный слэш', 'duplexnt-app://app/assets\\..\\index.html'],
    ['абсолютный путь Windows', 'duplexnt-app://app/D:/secrets/index.html'],
    ['поток NTFS', 'duplexnt-app://app/index.html::$DATA'],
    ['хвостовая точка', 'duplexnt-app://app/index.html.'],
    ['двойная точка в имени', 'duplexnt-app://app/index..html'],
    ['кириллица в имени', 'duplexnt-app://app/индекс.html'],
    ['не URL', 'не url'],
  ])('отклоняет: %s', (_name, url) => {
    expect(resolveAppFile(url, ROOT)).toBeNull();
  });

  it('принятый путь лежит строго под каталогом renderer, а не рядом с общим префиксом', () => {
    // `out/renderer-x/index.html` начинается с `out/renderer`, но не с `out/renderer<разделитель>`.
    const file = resolveAppFile('duplexnt-app://app/assets/index-Ds9l4Mit.js', ROOT);
    expect(file?.path.startsWith(ROOT + sep)).toBe(true);
    expect(file?.path.startsWith(`${ROOT}-x`)).toBe(false);
    // Каталог с хвостовым разделителем и относительный каталог нормализуются к тому же корню.
    expect(resolveAppFile(APP_INDEX_URL, `${ROOT}${sep}`)?.path).toBe(join(ROOT, 'index.html'));
  });
});

describe('handleAppRequest', () => {
  it('документ: 200, text/html, nosniff, no-store, байты как есть', async () => {
    const { app, readFile } = source();

    const response = await get(APP_INDEX_URL, app);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(INDEX);
    expect(readFile).toHaveBeenCalledExactlyOnceWith(join(ROOT, 'index.html'));
  });

  it('ассет отдаётся со своим типом', async () => {
    const css = Uint8Array.of(0x62, 0x6f, 0x64, 0x79);
    const { app } = source({ 'assets/index-DmMg5Tu9.css': css });

    const response = await get('duplexnt-app://app/assets/index-DmMg5Tu9.css', app);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(css);
  });

  it('не GET — 404 без обращения к файлам', async () => {
    const { app, readFile } = source();
    for (const method of ['POST', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) {
      const response = await handleAppRequest({ method, url: APP_INDEX_URL }, app);
      expect(response.status, method).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(readFile).not.toHaveBeenCalled();
  });

  it('негодный адрес — 404 без обращения к файлам', async () => {
    const { app, readFile } = source();
    for (const url of [
      'duplexnt-app://other/index.html',
      'duplexnt-app://app/assets/../../package.json',
      'duplexnt-app://app/%2e%2e/package.json',
      'duplexnt-app://app/nope.txt',
      'duplexnt-app://app/index.html?x=1',
    ]) {
      expect((await get(url, app)).status, url).toBe(404);
    }
    expect(readFile).not.toHaveBeenCalled();
  });

  it('отсутствующий файл и ошибка чтения — 404', async () => {
    const { app, readFile } = source();

    const response = await get('duplexnt-app://app/assets/missing-00000000.js', app);

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(readFile).toHaveBeenCalledExactlyOnceWith(join(ROOT, 'assets', 'missing-00000000.js'));
  });
});
