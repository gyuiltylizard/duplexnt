// Уведомления о сторонних компонентах (B-40, KTD-3): чистый модуль генератора
// THIRD-PARTY-NOTICES.txt. Состав берётся не из `dependencies`, а из фактической сборки: Vite
// инлайнит в out/ пакеты из devDependencies (React, i18next, pdf-lib, шрифты OFL и их
// транзитивные зависимости), а в asar из node_modules едут только `sharp` и его дерево. Два
// источника — JSON плагина `tooling/bundled-packages-plugin.ts` (по одному на каждую из трёх
// сборок electron-vite) и дерево `npm list` той же командой, что у коллектора electron-builder.
//
// Здесь нет ввода-вывода процесса: пути, разобранный JSON и тексты лицензий приходят снаружи, так
// что тесты работают на временных каталогах, а раннер `third-party-notices.ts` только читает,
// зовёт npm и пишет файл. Файл запускается Node напрямую (снятие типов), поэтому здесь нет enum,
// namespace и parameter properties, а импорты — только `node:*`.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Пакет из бандла или из asar: имя, версия и путь каталога относительно корня репозитория. */
export interface BundledPackage {
  readonly name: string;
  readonly version: string;
  /** Относительно корня репозитория, с прямыми слэшами (`node_modules/sharp/node_modules/semver`). */
  readonly path: string;
}

/** Файл `third-party-packages.json`, который плагин кладёт в outDir каждой сборки. */
export interface BundledPackagesFile {
  readonly packages: readonly BundledPackage[];
  /** Внешние импорты чанков (не инлайнены): `electron`, `sharp`, `node:*`. */
  readonly externals: readonly string[];
}

/** Запись уведомления: пакет, его лицензии и текст, который едет в файл. */
export interface NoticeEntry extends BundledPackage {
  readonly licenses: readonly string[];
  readonly text: string;
}

/** Имя закоммиченного файла и файла в корне установки. */
export const NOTICES_FILE = 'THIRD-PARTY-NOTICES.txt';

/**
 * Допустимые лицензии — ровно фактический состав сборки. Незнакомый идентификатор роняет генерацию
 * с именем пакета: расширение перечня — осознанный шаг, а не молчаливое попадание в установщик.
 */
export const ALLOWED_LICENSES: readonly string[] = [
  'MIT',
  'ISC',
  '0BSD',
  'Apache-2.0',
  'OFL-1.1',
  'LGPL-3.0-or-later',
];

/** Лицензии, для которых есть канонический текст на случай пакета без файла лицензии. */
export const CANONICAL_LICENSES: readonly string[] = ['MIT', 'ISC', '0BSD'];

export const MANIFEST_BEGIN = '== Components (name@version  path) ==';
export const MANIFEST_END = '== End of components ==';

const RULE = '='.repeat(78);
const THIN = '-'.repeat(78);

const byName = (a: BundledPackage, b: BundledPackage): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const toPosix = (value: string): string => value.replaceAll('\\', '/');

/** Проверяет форму JSON плагина; `source` — для сообщения об ошибке. */
export function parseBundledPackagesFile(value: unknown, source: string): BundledPackagesFile {
  if (!isRecord(value) || !Array.isArray(value.packages) || !Array.isArray(value.externals)) {
    throw new Error(`${source}: ждали {packages: [...], externals: [...]}`);
  }
  const packages = value.packages.map((item: unknown, index): BundledPackage => {
    if (
      !isRecord(item) ||
      typeof item.name !== 'string' ||
      typeof item.version !== 'string' ||
      typeof item.path !== 'string'
    ) {
      throw new Error(`${source}: packages[${String(index)}] без name/version/path`);
    }
    return { name: item.name, version: item.version, path: item.path };
  });
  const externals = value.externals.map((item: unknown, index): string => {
    if (typeof item !== 'string') {
      throw new Error(`${source}: externals[${String(index)}] не строка`);
    }
    return item;
  });
  return { packages, externals };
}

/**
 * Установленные пакеты из дерева `npm list … --json --long`: узлы с `version` и `path`.
 * Неустановленные optional (другие платформы sharp) приходят пустыми объектами и отбрасываются.
 */
export function installedFromNpmList(tree: unknown, repoRoot: string): BundledPackage[] {
  const found = new Map<string, BundledPackage>();
  const root = toPosix(repoRoot).replace(/\/+$/, '');
  const visit = (node: unknown): void => {
    if (!isRecord(node) || !isRecord(node.dependencies)) {
      return;
    }
    for (const [name, child] of Object.entries(node.dependencies)) {
      if (!isRecord(child) || typeof child.version !== 'string' || typeof child.path !== 'string') {
        continue;
      }
      const absolute = toPosix(child.path);
      const path = absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : absolute;
      if (!found.has(path)) {
        found.set(path, { name, version: child.version, path });
      }
      visit(child);
    }
  };
  visit(tree);
  return [...found.values()].sort(byName);
}

/** Объединение списков по пути каталога, отсортированное по имени. */
export function mergePackages(...lists: readonly (readonly BundledPackage[])[]): BundledPackage[] {
  const found = new Map<string, BundledPackage>();
  for (const list of lists) {
    for (const pkg of list) {
      if (!found.has(pkg.path)) {
        found.set(pkg.path, pkg);
      }
    }
  }
  return [...found.values()].sort(byName);
}

/**
 * Идентификаторы SPDX из поля `license` (строка, объект `{type}`, выражение `A AND B`) или
 * устаревшего `licenses` (массив). Каждый обязан быть в ALLOWED_LICENSES.
 */
export function normalizeLicense(meta: unknown, name: string): string[] {
  const raw = isRecord(meta) ? (meta.license ?? meta.licenses) : undefined;
  const expressions: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string') {
      expressions.push(value);
    } else if (isRecord(value) && typeof value.type === 'string') {
      expressions.push(value.type);
    } else {
      throw new Error(`${name}: поле license неразборчиво`);
    }
  };
  if (Array.isArray(raw)) {
    raw.forEach(push);
  } else if (raw !== undefined) {
    push(raw);
  }
  if (expressions.length === 0) {
    throw new Error(`${name}: поле license отсутствует`);
  }
  const ids: string[] = [];
  for (const expression of expressions) {
    for (const token of expression.split(/[\s()]+/).filter((part) => part !== '')) {
      if (token === 'AND' || token === 'OR') {
        continue;
      }
      if (token === 'WITH') {
        throw new Error(`${name}: исключение WITH в «${expression}» не поддерживается`);
      }
      if (!ALLOWED_LICENSES.includes(token)) {
        throw new Error(`${name}: лицензия ${token} вне перечня (${ALLOWED_LICENSES.join(', ')})`);
      }
      if (!ids.includes(token)) {
        ids.push(token);
      }
    }
  }
  return ids;
}

/** Файлы лицензий и уведомлений в корне пакета, регистронезависимо: сначала лицензии, затем NOTICE. */
export function licenseFilesIn(dir: string): string[] {
  const rank = (entry: string): number => (/^notice/i.test(entry) ? 1 : 0);
  return readdirSync(dir)
    .filter((entry) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(entry))
    .sort((a, b) => rank(a) - rank(b) || a.toLowerCase().localeCompare(b.toLowerCase(), 'en'));
}

/** Имя правообладателя из `author`: строка без `<email>` и `(url)` или объект с `name`. */
export function holderOf(meta: unknown): string {
  const author = isRecord(meta) ? meta.author : undefined;
  if (typeof author === 'string') {
    return author
      .replace(/<[^>]*>/g, '')
      .replace(/\([^)]*\)/g, '')
      .trim();
  }
  if (isRecord(author) && typeof author.name === 'string') {
    return author.name.trim();
  }
  return '';
}

const normalizeText = (text: string): string =>
  text
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();

/**
 * Запись для пакета: читает его package.json и файлы лицензий. Без файлов — канонический текст по
 * SPDX-id из `canonical` с копирайтом из `author`; без того и другого — падение с именем пакета.
 */
export function readNoticeEntry(
  pkg: BundledPackage,
  repoRoot: string,
  canonical: ReadonlyMap<string, string>,
): NoticeEntry {
  const dir = join(repoRoot, pkg.path);
  const meta: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (!isRecord(meta) || meta.name !== pkg.name) {
    throw new Error(`${pkg.path}: package.json не от пакета ${pkg.name}`);
  }
  const licenses = normalizeLicense(meta, pkg.name);
  const files = licenseFilesIn(dir);
  let text: string;
  if (files.length > 0) {
    text = files.map((file) => normalizeText(readFileSync(join(dir, file), 'utf8'))).join('\n\n');
  } else {
    const holder = holderOf(meta);
    if (holder === '') {
      throw new Error(`${pkg.name}: нет файла лицензии и нет author для канонического текста`);
    }
    text = licenses
      .map((id) => {
        const template = canonical.get(id);
        if (template === undefined) {
          throw new Error(`${pkg.name}: нет файла лицензии, а для ${id} нет канонического текста`);
        }
        return normalizeText(template.replace('{{COPYRIGHT}}', `Copyright (c) ${holder}`));
      })
      .join('\n\n');
  }
  return { ...pkg, licenses, text };
}

/** Канонические тексты из каталога `scripts/notices-texts/`: `<SPDX>.txt` → шаблон. */
export function loadCanonicalTexts(dir: string): Map<string, string> {
  return new Map(
    CANONICAL_LICENSES.map((id) => [id, readFileSync(join(dir, `${id}.txt`), 'utf8')] as const),
  );
}

/**
 * Раздел «Licensing» README пакета `@img/sharp-win32-x64`: от строки про сторонние библиотеки до
 * просьбы сообщать об ошибках — там таблица лицензий libvips и его зависимостей.
 */
export function extractLibvipsLicensing(readme: string): string {
  const start = readme.indexOf('This software contains third-party libraries');
  if (start < 0) {
    throw new Error('README @img/sharp-win32-x64: не найден раздел о сторонних библиотеках');
  }
  const end = readme.indexOf('Please report', start);
  return normalizeText(readme.slice(start, end < 0 ? undefined : end));
}

export interface LibvipsNotice {
  /** Имя и версия пакета, в котором едет libvips (`@img/sharp-win32-x64 0.35.4`). */
  readonly carrier: string;
  /** Содержимое `versions.json`: библиотека → версия. */
  readonly components: Readonly<Record<string, string>>;
  /** Таблица лицензий из README (extractLibvipsLicensing). */
  readonly licensing: string;
  /** Полный текст LGPL-3.0. */
  readonly lgplText: string;
}

export interface NoticesInput {
  readonly appVersion: string;
  readonly entries: readonly NoticeEntry[];
  readonly libvips: LibvipsNotice;
}

/** Строка перечня: `name@version  path`. */
export const manifestLine = (pkg: BundledPackage): string =>
  `${pkg.name}@${pkg.version}  ${pkg.path}`;

/** Перечень из шапки файла — для теста, сверяющего версии с node_modules без сборки. */
export function parseManifest(text: string): BundledPackage[] {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const begin = lines.indexOf(MANIFEST_BEGIN);
  const end = lines.indexOf(MANIFEST_END);
  if (begin < 0 || end < begin) {
    throw new Error(`${NOTICES_FILE}: перечень не найден`);
  }
  return lines.slice(begin + 1, end).map((line) => {
    const match = /^(?<name>\S+)@(?<version>[^@\s]+) {2}(?<path>\S+)$/.exec(line);
    if (match?.groups === undefined) {
      throw new Error(`${NOTICES_FILE}: строка перечня неразборчива: ${line}`);
    }
    return {
      name: match.groups.name ?? '',
      version: match.groups.version ?? '',
      path: match.groups.path ?? '',
    };
  });
}

/** Текст файла уведомлений: детерминирован, LF, одинаковые тексты лицензий — одним блоком. */
export function renderNotices({ appVersion, entries, libvips }: NoticesInput): string {
  const sorted = [...entries].sort(byName);
  const out: string[] = [];
  out.push(`THIRD-PARTY NOTICES FOR DUPLEXN'T ${appVersion}`);
  out.push('');
  out.push(
    "Duplexn't is licensed under the GNU General Public License, version 3 only (see",
    'LICENSE.txt next to this file). The installed application bundles the third-party',
    'components listed below under their own licenses; their notices and license texts',
    'follow. Electron and Chromium notices are in LICENSE.electron.txt and',
    'LICENSES.chromium.html next to this file.',
  );
  out.push('');
  out.push(MANIFEST_BEGIN);
  for (const entry of sorted) {
    out.push(manifestLine(entry));
  }
  out.push(MANIFEST_END);

  const groups = new Map<string, NoticeEntry[]>();
  for (const entry of sorted) {
    const key = entry.text.replace(/\s+/g, ' ');
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [entry]);
    } else {
      group.push(entry);
    }
  }
  for (const group of groups.values()) {
    out.push('', RULE);
    for (const entry of group) {
      out.push(`${entry.name} ${entry.version} (${entry.licenses.join(' AND ')})`);
    }
    out.push(THIN, group[0]?.text ?? '');
  }

  out.push('', RULE);
  out.push(`libvips and the native libraries built into ${libvips.carrier}`);
  out.push(THIN);
  out.push('Components and versions (from versions.json of that package):');
  for (const [library, version] of Object.entries(libvips.components).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    out.push(`  ${library} ${version}`);
  }
  out.push('');
  out.push('Licensing of these libraries, as stated by the package README:');
  out.push('');
  out.push(libvips.licensing);
  out.push('');
  out.push(
    'The libraries listed as LGPLv3 (libvips, glib, pango, librsvg, libheif, fribidi,',
    'libexif, proxy-libintl) are used under the GNU Lesser General Public License,',
    'version 3, reproduced below. They are shipped as separate DLL files next to the',
    'application, so they can be replaced with modified versions.',
  );
  out.push('');
  out.push(normalizeText(libvips.lgplText));
  out.push('');
  return out.join('\n');
}
