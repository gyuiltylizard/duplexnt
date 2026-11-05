import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Лендинг GitHub Pages в docs/ (B-40, U4; памятка docs/landing.md). Сайт передан готовым и
// правится руками, поэтому тест держит то, что ломается молча: ссылки на репозиторий, файлы, на
// которые ссылается страница (с точным регистром — Pages на Linux его различает, Windows нет),
// адрес Pages в приложении.

const DOCS = 'docs';
const REPO = 'https://github.com/gyuiltylizard/duplexnt';
const PAGES = 'https://gyuiltylizard.github.io/duplexnt/';

const html = readFileSync(join(DOCS, 'index.html'), 'utf8');
const fontsCss = readFileSync(join(DOCS, 'assets', 'fonts', 'fonts.css'), 'utf8');

/** Файл существует и каждый сегмент пути совпадает с именем в каталоге с точностью до регистра. */
function existsCaseExact(relativeToDocs: string): boolean {
  let dir = DOCS;
  for (const segment of relativeToDocs.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (!readdirSync(dir).includes(segment)) {
      return false;
    }
    dir = join(dir, segment);
  }
  return existsSync(dir);
}

const attributeUrls = (source: string): string[] =>
  [...source.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((match) => match[1] ?? '');

const isLocal = (url: string): boolean => !/^(?:https?:|mailto:|data:|#)/.test(url) && url !== '';

describe('docs/ — лендинг для GitHub Pages (B-40)', () => {
  it('входная точка и .nojekyll на месте, заглушек OWNER нет', () => {
    expect(existsSync(join(DOCS, 'index.html'))).toBe(true);
    expect(existsSync(join(DOCS, '.nojekyll'))).toBe(true);
    expect(html).not.toContain('OWNER/');
  });

  it('все локальные href/src страницы и url() шрифтов указывают на существующие файлы с тем же регистром', () => {
    const fromHtml = attributeUrls(html).filter(isLocal);
    const fromCss = [...fontsCss.matchAll(/url\(([^)]+)\)/g)]
      .map((match) => (match[1] ?? '').replace(/^['"]|['"]$/g, ''))
      .filter(isLocal)
      .map((url) => join('assets/fonts', url).replaceAll('\\', '/'));
    const all = [...new Set([...fromHtml, ...fromCss])].map((url) => url.replace(/[?#].*$/, ''));
    expect(all.length).toBeGreaterThan(5);
    for (const url of all) {
      expect(existsCaseExact(url), url).toBe(true);
    }
  });

  it('картинки по языкам: пути из locales.js (src через data-i18n-attr) существуют с тем же регистром', () => {
    const locales = readFileSync(join(DOCS, 'assets', 'js', 'locales.js'), 'utf8');
    const fromLocales = [...locales.matchAll(/"(assets\/img\/[^"]+)"/g)].map(
      (match) => match[1] ?? '',
    );
    expect(fromLocales.length).toBeGreaterThanOrEqual(3);
    for (const url of fromLocales) {
      expect(existsCaseExact(url), url).toBe(true);
    }
    // Каждому src с подменой по языку в разметке отвечает ключ в переводах.
    const keys = [...html.matchAll(/data-i18n-attr="[^"]*src:([^";]+)/g)].map(
      (match) => match[1] ?? '',
    );
    expect(keys.length).toBeGreaterThanOrEqual(3);
    for (const key of keys) {
      expect(locales, key).toContain(`"${key}"`);
    }
  });

  it('ссылки на GitHub — только на настоящий репозиторий; «Скачать» ведёт на список релизов, не на latest и не на exe', () => {
    const github = attributeUrls(html).filter((url) => url.startsWith('https://github.com/'));
    expect(github.length).toBeGreaterThan(0);
    for (const url of github) {
      expect(url.startsWith(REPO), url).toBe(true);
      expect(url, url).not.toContain('/releases/latest');
      expect(url, url).not.toMatch(/\.exe$/);
    }
    expect(github.some((url) => url === `${REPO}/releases`)).toBe(true);
  });

  it('переводы объявлены для русского языка', () => {
    const locales = readFileSync(join(DOCS, 'assets', 'js', 'locales.js'), 'utf8');
    expect(locales).toMatch(/window\.DUPLEXNT_LOCALES\s*=/);
    expect(locales).toMatch(/"ru"\s*:/);
  });

  it('бейдж BETA в приложении ведёт на адрес Pages', () => {
    const main = readFileSync(join('src', 'main', 'index.ts'), 'utf8');
    expect(main).toContain(`const PROJECT_PAGE_URL = '${PAGES}';`);
  });

  it('памятка docs/landing.md называет тот же адрес Pages и страницу релизов', () => {
    const memo = readFileSync(join(DOCS, 'landing.md'), 'utf8');
    expect(memo).toContain(PAGES);
    expect(memo).toContain(`${REPO}/releases`);
    expect(dirname(join(DOCS, 'landing.md'))).toBe(DOCS);
  });
});
