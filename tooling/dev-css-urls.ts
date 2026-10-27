import type { Plugin } from 'vite';

// Адреса ассетов в CSS под dev-сервером. Vite переписывает `url(./files/x.woff2)` из пакетов
// (шрифты Fontsource) в абсолютный `url(/@fs/X:/repo/Duplexn't/node_modules/…)` без кавычек.
// Апостроф в пути проекта делает такой `url()` некорректным: браузер выбрасывает объявление
// `src`, `@font-face` остаётся без файла, и вместо Golos Text и IBM Plex Mono рисуются системные
// Segoe UI и Courier New. В сборке ассеты лежат в `assets/` с хэшем в имени — там пути без
// апострофа, поэтому плагин работает только под `serve`. Апостроф кодируется как `%27`: dev-сервер
// декодирует путь перед чтением файла.

/** Кодирует апострофы в путях `url(/@fs/…)` — без кавычек они ломают объявление. */
export function encodeDevCssUrls(code: string): string {
  return code.replace(/url\((\/@fs\/[^)]*)\)/g, (_match, path: string) =>
    path.includes("'") ? `url(${path.replaceAll("'", '%27')})` : `url(${path})`,
  );
}

export function devCssUrls(): Plugin {
  return {
    name: 'duplexnt:dev-css-urls',
    apply: 'serve',
    enforce: 'post',
    transform(code, id) {
      if (!/\.css(?:$|\?)/.test(id) || !code.includes("'")) {
        return null;
      }
      const next = encodeDevCssUrls(code);
      return next === code ? null : { code: next, map: null };
    },
  };
}
