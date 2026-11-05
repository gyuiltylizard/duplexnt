import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_HOST, APP_SCHEME, resolveAppFile } from '../../src/main/app-protocol';
import { BUNDLED_PACKAGES_FILE } from '../../tooling/bundled-packages-plugin';
import { buildCsp, parseCsp } from '../../tooling/csp';

// Собранный renderer (B-28; B-29, U1). Сборка идёт во временный каталог из самого теста:
// `out/` может быть устаревшим или отсутствовать, а тест не должен его трогать. Проверяется то,
// что ни один модульный тест не видит: мета-тег CSP в `index.html` несёт сборочный профиль
// (ослабленный профиль dev в сборку не попал), а всё, что сборка положила в каталог, схема
// интерфейса умеет отдать — иначе новый тип ассета молча стал бы 404 в упакованном приложении.

const BUILD_TIMEOUT_MS = 180_000;
// Через `node_modules` напрямую: `exports` пакета bin не публикует.
const ELECTRON_VITE = join(
  process.cwd(),
  'node_modules',
  'electron-vite',
  'bin',
  'electron-vite.js',
);

let outDir: string;
let rendererDir: string;
let html: string;

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'duplexnt-build-csp-'));
  rendererDir = join(outDir, 'renderer');
  // Та же переменная, что снимает electron.vite.config.ts: здесь — чтобы сборка не зависела от
  // окружения редактора автора.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const build = spawnSync(process.execPath, [ELECTRON_VITE, 'build', '--outDir', outDir], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: BUILD_TIMEOUT_MS,
  });
  if (build.status !== 0) {
    throw new Error(
      `electron-vite build завершился кодом ${String(build.status)}:\n${build.stderr}`,
    );
  }
  html = readFileSync(join(rendererDir, 'index.html'), 'utf8');
}, BUILD_TIMEOUT_MS);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

/** Содержимое мета-тега CSP; сущности HTML, которыми Vite экранирует кавычки, — обратно. */
function metaCsp(): string {
  const match = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  if (match === null) {
    throw new Error('в index.html нет мета-тега CSP');
  }
  return (match[1] ?? '').replaceAll('&#39;', "'").replaceAll('&quot;', '"');
}

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      yield* files(path);
    } else {
      yield path;
    }
  }
}

describe('собранный index.html', () => {
  it('несёт ровно сборочный профиль CSP, и он единственный', () => {
    expect(metaCsp()).toBe(buildCsp({ profile: 'build' }));
    expect(html.match(/http-equiv="Content-Security-Policy"/g)).toHaveLength(1);
  });

  it('профиль dev в сборку не попал', () => {
    const directives = parseCsp(metaCsp());
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(directives.get('connect-src')).toEqual(["'none'"]);
    for (const forbidden of ["'unsafe-inline'", 'localhost', 'ws:', 'http:']) {
      expect(metaCsp()).not.toContain(forbidden);
    }
  });

  it('ссылается на ассеты относительно документа — так они живут на схеме интерфейса', () => {
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref, ref).toMatch(/^\.\/assets\//);
    }
  });
});

describe('схема интерфейса и каталог сборки', () => {
  it('каждый файл сборки схема умеет отдать: путь и тип в белом списке', () => {
    const emitted = [...files(rendererDir)].map((path) => relative(rendererDir, path));
    expect(emitted).toContain('index.html');
    expect(emitted.length).toBeGreaterThan(10);
    for (const file of emitted) {
      const url = `${APP_SCHEME}://${APP_HOST}/${file.split('\\').join('/')}`;
      const resolved = resolveAppFile(url, rendererDir);
      if (file === BUNDLED_PACKAGES_FILE) {
        // Служебный файл плагина состава сборки (B-40): в asar не едет (`files:` в
        // electron-builder.yml), и схема его отдавать не должна — JSON вне белого списка типов.
        expect(resolved, `${file}: служебный JSON не должен отдаваться схемой`).toBeNull();
        continue;
      }
      expect(resolved, `${file}: схема не отдаст этот файл`).not.toBeNull();
      expect(resolved?.path).toBe(join(rendererDir, file));
    }
  });

  it('ассеты из index.html существуют в каталоге сборки', () => {
    const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1] ?? '');
    for (const ref of refs) {
      expect(() => statSync(join(rendererDir, ...ref.split('/'))), ref).not.toThrow();
    }
  });
});
