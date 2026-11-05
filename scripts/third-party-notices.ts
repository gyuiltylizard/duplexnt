// Генератор THIRD-PARTY-NOTICES.txt (B-40, KTD-3). Запуск из корня после `npm run build`:
// `npm run notices` — переписать файл; `--check` — сравнить с закоммиченным байт в байт и выйти
// ненулём при расхождении (так идёт в `npm run dist`: дрейф состава роняет сборку установщика,
// а не проходит в неё молча). Источники: `out/{main,preload,renderer}/third-party-packages.json`
// плагина сборки и дерево `npm list` той же командой, что у коллектора electron-builder 26.
//
// npm запускается как скрипт Node: `npm.cmd` напрямую спавнить нельзя (Node ≥ 22 даёт EINVAL,
// `shell: true` — DEP0190), путь к npm-cli.js — из `npm_execpath` под `npm run`, иначе рядом с
// текущим Node. Файл запускается Node напрямую (снятие типов): без enum, namespace и parameter
// properties, импорты — только `node:*` и `./*.ts`.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOTICES_FILE,
  extractLibvipsLicensing,
  installedFromNpmList,
  loadCanonicalTexts,
  mergePackages,
  parseBundledPackagesFile,
  readNoticeEntry,
  renderNotices,
  type BundledPackage,
} from './notices.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['main', 'preload', 'renderer'] as const;
const BUNDLED_FILE = 'third-party-packages.json';
const LIBVIPS_CARRIER = '@img/sharp-win32-x64';

function npmCli(): string {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv !== undefined && fromEnv !== '' && existsSync(fromEnv)) {
    return fromEnv;
  }
  const next = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(next)) {
    throw new Error(`npm-cli.js не найден ни в npm_execpath, ни рядом с Node: ${next}`);
  }
  return next;
}

/** Дерево установленных production-зависимостей — команда коллектора electron-builder. */
function npmListTree(): unknown {
  const result = spawnSync(
    process.execPath,
    [
      npmCli(),
      'list',
      '-a',
      '--include',
      'prod',
      '--include',
      'optional',
      '--omit',
      'dev',
      '--json',
      '--long',
    ],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error(`npm list не вернул JSON (код ${String(result.status)}): ${result.stderr}`);
  }
}

const isBuiltin = (specifier: string): boolean =>
  specifier.startsWith('node:') || builtinModules.includes(specifier);

function main(argv: readonly string[]): number {
  const check = argv.includes('--check');

  const bundled: BundledPackage[][] = [];
  const externals = new Set<string>();
  for (const target of TARGETS) {
    const file = join(ROOT, 'out', target, BUNDLED_FILE);
    if (!existsSync(file)) {
      console.error(`notices: нет ${file} — сначала npm run build`);
      return 2;
    }
    const parsed = parseBundledPackagesFile(
      JSON.parse(readFileSync(file, 'utf8')) as unknown,
      `out/${target}/${BUNDLED_FILE}`,
    );
    bundled.push([...parsed.packages]);
    for (const specifier of parsed.externals) {
      externals.add(specifier);
    }
  }

  const installed = installedFromNpmList(npmListTree(), ROOT);
  const installedNames = new Set(installed.map((pkg) => pkg.name));
  for (const specifier of externals) {
    const packageName = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : (specifier.split('/')[0] ?? specifier);
    if (packageName === 'electron' || isBuiltin(specifier) || installedNames.has(packageName)) {
      continue;
    }
    console.error(
      `notices: внешний импорт ${specifier} не найден среди установленных production-зависимостей`,
    );
    return 1;
  }

  const canonical = loadCanonicalTexts(join(ROOT, 'scripts', 'notices-texts'));
  const packages = mergePackages(...bundled, installed);
  const entries = packages.map((pkg) => readNoticeEntry(pkg, ROOT, canonical));

  const carrier = installed.find((pkg) => pkg.name === LIBVIPS_CARRIER);
  if (carrier === undefined) {
    console.error(`notices: ${LIBVIPS_CARRIER} не установлен — сборка Windows без libvips?`);
    return 1;
  }
  const carrierDir = join(ROOT, carrier.path);
  const components = JSON.parse(readFileSync(join(carrierDir, 'versions.json'), 'utf8')) as Record<
    string,
    string
  >;

  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    version: string;
  };
  const text = renderNotices({
    appVersion: version,
    entries,
    libvips: {
      carrier: `${carrier.name} ${carrier.version}`,
      components,
      licensing: extractLibvipsLicensing(readFileSync(join(carrierDir, 'README.md'), 'utf8')),
      lgplText: readFileSync(join(ROOT, 'scripts', 'notices-texts', 'LGPL-3.0.txt'), 'utf8'),
    },
  });

  const target = join(ROOT, NOTICES_FILE);
  if (check) {
    const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
    if (current !== text) {
      console.error(`notices: ${NOTICES_FILE} устарел — выполните npm run notices и закоммитьте`);
      return 1;
    }
    console.log(`notices: ${NOTICES_FILE} актуален (${String(entries.length)} пакетов)`);
    return 0;
  }
  writeFileSync(target, text);
  console.log(`notices: ${NOTICES_FILE} записан (${String(entries.length)} пакетов)`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
