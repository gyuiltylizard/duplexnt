import { readFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import type { Plugin } from 'vite';
import type { BundledPackage, BundledPackagesFile } from '../scripts/notices.ts';

// Состав бандла для уведомлений о сторонних компонентах (B-40, KTD-3). Vite инлайнит в out/
// пакеты из devDependencies (React, i18next, pdf-lib, шрифты и их транзитивные зависимости), и
// ни `dependencies`, ни статический список их не покажут. Плагин в `generateBundle` берёт
// `moduleIds` всех чанков — то, что реально отрендерено, — сводит их к пакетам и кладёт
// `third-party-packages.json` в outDir своей сборки. Файлов три (main, preload, renderer): каждый
// outDir Vite чистит сам, поэтому накопительного файла с мёртвыми записями не возникает.
// Генератор `scripts/third-party-notices.ts` берёт объединение; в asar JSON не едет
// (исключение в `files:` electron-builder.yml).

export const BUNDLED_PACKAGES_FILE = 'third-party-packages.json';

const toPosix = (value: string): string => value.replaceAll('\\', '/');

const hasNameAndVersion = (packageJson: string): boolean => {
  try {
    const meta: unknown = JSON.parse(readFileSync(packageJson, 'utf8'));
    return (
      typeof meta === 'object' &&
      meta !== null &&
      typeof (meta as { name?: unknown }).name === 'string' &&
      typeof (meta as { version?: unknown }).version === 'string'
    );
  } catch {
    return false;
  }
};

/**
 * Каталог пакета для модуля из node_modules: ближайший вверх package.json с `name` и `version`,
 * не выше корня пакета (`node_modules/<имя>` или `node_modules/@scope/<имя>`). Виртуальные
 * модули, модули вне node_modules и подкаталоги без своего имени (например `{ "type": "module" }`)
 * поднимаются к пакету или отбрасываются.
 */
export function packageDirOf(moduleId: string): string | null {
  if (moduleId.startsWith('\0')) {
    return null;
  }
  const id = toPosix(moduleId).replace(/[?#].*$/, '');
  const marker = '/node_modules/';
  const at = id.lastIndexOf(marker);
  if (at < 0) {
    return null;
  }
  const rest = id.slice(at + marker.length).split('/');
  const depth = rest[0]?.startsWith('@') === true ? 2 : 1;
  if (rest.length <= depth) {
    return null;
  }
  const packageRoot = id.slice(0, at + marker.length) + rest.slice(0, depth).join('/');
  let dir = dirname(id);
  while (dir.startsWith(packageRoot)) {
    if (hasNameAndVersion(`${dir}/package.json`)) {
      return dir;
    }
    if (dir === packageRoot) {
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
  return null;
}

/** Пакеты по идентификаторам модулей: без дублей, пути относительно `repoRoot`, по имени. */
export function packagesFromModuleIds(ids: Iterable<string>, repoRoot: string): BundledPackage[] {
  const found = new Map<string, BundledPackage>();
  for (const id of ids) {
    const dir = packageDirOf(id);
    if (dir === null) {
      continue;
    }
    const path = toPosix(relative(repoRoot, dir));
    if (found.has(path)) {
      continue;
    }
    const meta = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')) as {
      name: string;
      version: string;
    };
    found.set(path, { name: meta.name, version: meta.version, path });
  }
  return [...found.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

export function bundledPackagesPlugin(repoRoot: string = process.cwd()): Plugin {
  return {
    name: 'duplexnt:bundled-packages',
    apply: 'build',
    generateBundle(_options, bundle) {
      const ids = new Set<string>();
      const externals = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') {
          continue;
        }
        for (const id of output.moduleIds) {
          ids.add(id);
        }
        for (const specifier of [...output.imports, ...output.dynamicImports]) {
          if (!(specifier in bundle)) {
            externals.add(specifier);
          }
        }
      }
      const file: BundledPackagesFile = {
        packages: packagesFromModuleIds(ids, repoRoot),
        externals: [...externals].sort(),
      };
      this.emitFile({
        type: 'asset',
        fileName: BUNDLED_PACKAGES_FILE,
        source: `${JSON.stringify(file, null, 2)}\n`,
      });
    },
  };
}
