import { PAGE_IMAGE_SCHEME } from '../src/shared/bridge';

// Билдер Content-Security-Policy — чистый модуль без импорта Electron, закрытый тестом.
// Политика доставляется мета-тегом: его вставляет плагин Vite в electron.vite.config.ts,
// профиль выбирается по команде Vite, поэтому профиль разработки не может попасть в сборку.
// Единственное расширение — схема изображений страниц (план M1, KTD-38): только в `img-src`,
// в обоих профилях; `connect-src` и `default-src` её не получают.

export type CspOptions =
  { readonly profile: 'build' } | { readonly profile: 'dev'; readonly devServerOrigin: string };

type Directives = readonly (readonly [name: string, sources: readonly string[]])[];

// `default-src` не покрывает base-uri, form-action и object-src — они закрыты явно.
const BUILD_DIRECTIVES: Directives = [
  ['default-src', ["'none'"]],
  ['script-src', ["'self'"]],
  ['style-src', ["'self'"]],
  ['font-src', ["'self'"]],
  ['img-src', ["'self'", `${PAGE_IMAGE_SCHEME}:`]],
  ['connect-src', ["'none'"]],
  ['base-uri', ["'none'"]],
  ['form-action', ["'none'"]],
  ['object-src', ["'none'"]],
];

// Что HMR добавляет поверх сборочного профиля: преамбула React Refresh — инлайн-скрипт,
// стили Vite вставляет тегами <style>, обновления идут по WebSocket.
function devAdditions(origin: string, wsOrigin: string): ReadonlyMap<string, readonly string[]> {
  return new Map([
    ['script-src', ["'unsafe-inline'", origin]],
    ['style-src', ["'unsafe-inline'", origin]],
    ['font-src', [origin]],
    ['img-src', [origin]],
    ['connect-src', [origin, wsOrigin]],
  ]);
}

function parseDevOrigin(raw: string): { origin: string; wsOrigin: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`devServerOrigin: не URL — ${raw}`);
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'http:' || !isLocal) {
    throw new TypeError(`devServerOrigin: ожидается http://localhost:<порт>, получено ${raw}`);
  }
  return { origin: url.origin, wsOrigin: `ws://${url.host}` };
}

export function buildCsp(options: CspOptions): string {
  let directives = BUILD_DIRECTIVES;

  if (options.profile === 'dev') {
    const { origin, wsOrigin } = parseDevOrigin(options.devServerOrigin);
    const additions = devAdditions(origin, wsOrigin);
    directives = BUILD_DIRECTIVES.map(([name, sources]) => {
      const extra = additions.get(name);
      if (extra === undefined) {
        return [name, sources] as const;
      }
      return [name, [...sources.filter((source) => source !== "'none'"), ...extra]] as const;
    });
  }

  return directives.map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
}

export function parseCsp(csp: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name !== undefined && name !== '') {
      result.set(name, sources);
    }
  }
  return result;
}
