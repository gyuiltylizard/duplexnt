import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NOTICES_FILE,
  extractLibvipsLicensing,
  holderOf,
  installedFromNpmList,
  mergePackages,
  normalizeLicense,
  parseBundledPackagesFile,
  parseManifest,
  readNoticeEntry,
  renderNotices,
  type NoticeEntry,
} from '../../scripts/notices';

// Уведомления о сторонних компонентах (B-40, U2): нормализация SPDX, чтение пакета, детерминизм
// рендера — на временных пакетах; закоммиченный THIRD-PARTY-NOTICES.txt — против node_modules без
// сборки (версии из перечня в шапке). Новые пакеты в бандле ловит только `--check` в `npm run
// dist` — это записано в спеке «Команды».

let root = '';

const write = (relativePath: string, content: string): void => {
  const file = join(root, relativePath);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
};

const CANONICAL = new Map([
  ['MIT', '{{COPYRIGHT}}\n\nMIT text\n'],
  ['ISC', '{{COPYRIGHT}}\n\nISC text\n'],
]);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'duplexnt-notices-'));
  write(
    'node_modules/a/package.json',
    JSON.stringify({ name: 'a', version: '1.0.0', license: 'MIT' }),
  );
  write('node_modules/a/license.MD', 'Copyright A\r\n\r\nMIT text  \r\n');
  write('node_modules/a/NOTICE', 'Notice of A');
  write(
    'node_modules/b/package.json',
    JSON.stringify({
      name: 'b',
      version: '2.0.0',
      license: 'ISC',
      author: 'B Author <b@x.y> (https://b)',
    }),
  );
  write(
    'node_modules/c/package.json',
    JSON.stringify({ name: 'c', version: '3.0.0', license: 'OFL-1.1' }),
  );
  write(
    'node_modules/d/package.json',
    JSON.stringify({ name: 'd', version: '4.0.0', license: 'MIT' }),
  );
  write('node_modules/d/LICENSE', 'Copyright A\n\nMIT text\n');
  write(
    'node_modules/e/package.json',
    JSON.stringify({ name: 'other', version: '5.0.0', license: 'MIT' }),
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('normalizeLicense', () => {
  it('строка, объект {type}, массив licenses и составное выражение', () => {
    expect(normalizeLicense({ license: 'MIT' }, 'p')).toEqual(['MIT']);
    expect(normalizeLicense({ license: { type: 'ISC' } }, 'p')).toEqual(['ISC']);
    expect(normalizeLicense({ licenses: [{ type: 'MIT' }, 'ISC'] }, 'p')).toEqual(['MIT', 'ISC']);
    expect(normalizeLicense({ license: 'Apache-2.0 AND LGPL-3.0-or-later' }, 'p')).toEqual([
      'Apache-2.0',
      'LGPL-3.0-or-later',
    ]);
    expect(normalizeLicense({ license: '(MIT OR Apache-2.0)' }, 'p')).toEqual([
      'MIT',
      'Apache-2.0',
    ]);
  });

  it('идентификатор вне перечня, WITH и отсутствие поля — падение с именем пакета', () => {
    expect(() => normalizeLicense({ license: 'MIT AND GPL-2.0' }, 'pkg-x')).toThrow(
      /pkg-x.*GPL-2\.0/,
    );
    expect(() => normalizeLicense({ license: 'Apache-2.0 WITH LLVM-exception' }, 'pkg-y')).toThrow(
      /pkg-y/,
    );
    expect(() => normalizeLicense({}, 'pkg-z')).toThrow(/pkg-z/);
  });
});

describe('readNoticeEntry', () => {
  it('файл лицензии находится регистронезависимо, NOTICE дописывается, CRLF и хвостовые пробелы снимаются', () => {
    const entry = readNoticeEntry(
      { name: 'a', version: '1.0.0', path: 'node_modules/a' },
      root,
      CANONICAL,
    );
    expect(entry.licenses).toEqual(['MIT']);
    expect(entry.text).toBe('Copyright A\n\nMIT text\n\nNotice of A');
  });

  it('без файла и с известным SPDX — канонический текст с копирайтом из author', () => {
    const entry = readNoticeEntry(
      { name: 'b', version: '2.0.0', path: 'node_modules/b' },
      root,
      CANONICAL,
    );
    expect(entry.text).toBe('Copyright (c) B Author\n\nISC text');
  });

  it('без файла и без канонического текста или без author — падение с именем пакета', () => {
    expect(() =>
      readNoticeEntry({ name: 'c', version: '3.0.0', path: 'node_modules/c' }, root, CANONICAL),
    ).toThrow(/^c: /);
    expect(() =>
      readNoticeEntry({ name: 'd', version: '4.0.0', path: 'node_modules/d' }, root, new Map()),
    ).not.toThrow();
  });

  it('package.json другого пакета по этому пути — падение', () => {
    expect(() =>
      readNoticeEntry({ name: 'e', version: '5.0.0', path: 'node_modules/e' }, root, CANONICAL),
    ).toThrow(/node_modules\/e/);
  });

  it('holderOf: строка без email и url, объект с name, иначе пусто', () => {
    expect(holderOf({ author: 'Name <n@x.y> (https://x)' })).toBe('Name');
    expect(holderOf({ author: { name: 'Org' } })).toBe('Org');
    expect(holderOf({})).toBe('');
  });
});

describe('источники списка пакетов', () => {
  it('parseBundledPackagesFile принимает форму плагина и отвергает чужую', () => {
    expect(
      parseBundledPackagesFile(
        {
          packages: [{ name: 'a', version: '1', path: 'node_modules/a' }],
          externals: ['electron'],
        },
        'x',
      ),
    ).toEqual({
      packages: [{ name: 'a', version: '1', path: 'node_modules/a' }],
      externals: ['electron'],
    });
    expect(() =>
      parseBundledPackagesFile({ packages: [{ name: 'a' }], externals: [] }, 'src'),
    ).toThrow(/src/);
  });

  it('installedFromNpmList берёт только установленные узлы, пути относительно корня', () => {
    const tree = {
      dependencies: {
        sharp: {
          version: '0.35.4',
          path: `${root}\\node_modules\\sharp`,
          dependencies: {
            '@img/sharp-linux-x64': {},
            semver: { version: '7.8.5', path: `${root}/node_modules/sharp/node_modules/semver` },
          },
        },
      },
    };
    expect(installedFromNpmList(tree, root)).toEqual([
      { name: 'semver', version: '7.8.5', path: 'node_modules/sharp/node_modules/semver' },
      { name: 'sharp', version: '0.35.4', path: 'node_modules/sharp' },
    ]);
  });

  it('mergePackages объединяет по пути и сортирует по имени', () => {
    const a = { name: 'a', version: '1', path: 'node_modules/a' };
    const z = { name: 'z', version: '1', path: 'node_modules/z' };
    expect(mergePackages([z], [a, { ...z, version: '9' }])).toEqual([a, z]);
  });
});

describe('renderNotices', () => {
  const libvips = {
    carrier: '@img/sharp-win32-x64 0.35.4',
    components: { vips: '8.18.6', aom: '3.14.1' },
    licensing: 'This software contains third-party libraries\n| libvips | LGPLv3 |',
    lgplText: 'LGPL text',
  };
  const entries: NoticeEntry[] = [
    { name: 'z', version: '1.0.0', path: 'node_modules/z', licenses: ['MIT'], text: 'Same text' },
    { name: 'a', version: '2.0.0', path: 'node_modules/a', licenses: ['MIT'], text: 'Same  text' },
    { name: 'm', version: '3.0.0', path: 'node_modules/m', licenses: ['ISC'], text: 'Other' },
  ];

  it('детерминирован, LF, пакеты по имени, одинаковые тексты одним блоком', () => {
    const first = renderNotices({ appVersion: '1.0.0-beta.1', entries, libvips });
    const second = renderNotices({
      appVersion: '1.0.0-beta.1',
      entries: [...entries].reverse(),
      libvips,
    });
    expect(second).toBe(first);
    expect(first).not.toContain('\r');
    expect(first.indexOf('a 2.0.0 (MIT)\nz 1.0.0 (MIT)\n')).toBeGreaterThan(0);
    expect(first.match(/Same {1,2}text/g)).toHaveLength(1);
    expect(parseManifest(first)).toEqual([
      { name: 'a', version: '2.0.0', path: 'node_modules/a' },
      { name: 'm', version: '3.0.0', path: 'node_modules/m' },
      { name: 'z', version: '1.0.0', path: 'node_modules/z' },
    ]);
    expect(first).toContain('  aom 3.14.1\n  vips 8.18.6');
    expect(first).toContain('LGPL text');
  });

  it('extractLibvipsLicensing вырезает раздел от сторонних библиотек до просьбы о сообщениях', () => {
    const readme =
      'intro\nThis software contains third-party libraries\n| a | MIT |\n\nPlease report errors';
    expect(extractLibvipsLicensing(readme)).toBe(
      'This software contains third-party libraries\n| a | MIT |',
    );
    expect(() => extractLibvipsLicensing('nothing')).toThrow(/README/);
  });
});

describe(`${NOTICES_FILE} в репозитории`, () => {
  const text = readFileSync(NOTICES_FILE, 'utf8');

  it('версии перечня совпадают с node_modules (дрейф версий без сборки)', () => {
    const manifest = parseManifest(text);
    expect(manifest.length).toBeGreaterThan(10);
    for (const pkg of manifest) {
      const meta = JSON.parse(readFileSync(join(pkg.path, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
      };
      expect(`${meta.name}@${meta.version}`, pkg.path).toBe(`${pkg.name}@${pkg.version}`);
    }
  });

  it('содержит ожидаемые пакеты, разделы LGPL/libvips и OFL, указатель на лицензии Electron', () => {
    const names = new Set(parseManifest(text).map((pkg) => pkg.name));
    for (const name of [
      'sharp',
      '@img/sharp-win32-x64',
      'react',
      'i18next',
      '@cantoo/pdf-lib',
      '@fontsource/golos-text',
      '@fontsource/ibm-plex-mono',
    ]) {
      expect(names.has(name), name).toBe(true);
    }
    expect(text).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
    expect(text).toMatch(/^ {2}vips \d+\.\d+\.\d+$/m);
    expect(text).toContain('SIL OPEN FONT LICENSE');
    expect(text).toContain('LICENSE.electron.txt');
    expect(text).toContain('LICENSES.chromium.html');
  });

  it('без путей машины автора и без CRLF', () => {
    expect(text).not.toMatch(/[A-Z]:[\\/]/);
    expect(text).not.toMatch(/Users[\\/]/);
    expect(text).not.toContain('\r');
  });
});
