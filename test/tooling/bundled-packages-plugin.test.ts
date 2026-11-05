import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packageDirOf, packagesFromModuleIds } from '../../tooling/bundled-packages-plugin';

// Состав бандла для уведомлений (B-40, U2): идентификаторы модулей Rollup → пакеты. Проверяется
// чистая функция на временном дереве node_modules: scoped-пакет, вложенный semver, подкаталог без
// своего имени, виртуальные и внешние модули.

let root = '';

const write = (relativePath: string, content: string): void => {
  const file = join(root, relativePath);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
};

const pkg = (name: string, version: string): string => JSON.stringify({ name, version });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'duplexnt-bundled-'));
  write('node_modules/react/package.json', pkg('react', '19.0.0'));
  write('node_modules/react/index.js', '');
  write('node_modules/@scope/pkg/package.json', pkg('@scope/pkg', '2.0.0'));
  write('node_modules/@scope/pkg/dist/sub/package.json', JSON.stringify({ type: 'module' }));
  write('node_modules/@scope/pkg/dist/sub/x.js', '');
  write('node_modules/semver/package.json', pkg('semver', '6.3.1'));
  write('node_modules/sharp/package.json', pkg('sharp', '0.35.4'));
  write('node_modules/sharp/node_modules/semver/package.json', pkg('semver', '7.8.5'));
  write('node_modules/sharp/node_modules/semver/index.js', '');
  write('node_modules/noname/package.json', JSON.stringify({ private: true }));
  write('node_modules/noname/index.js', '');
  write('src/app.ts', '');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('packagesFromModuleIds (B-40)', () => {
  it('сводит модули к пакетам: scoped, вложенный semver своей версии, подкаталог без имени', () => {
    const ids = [
      join(root, 'node_modules/react/index.js'),
      join(root, 'node_modules/@scope/pkg/dist/sub/x.js'),
      join(root, 'node_modules/sharp/node_modules/semver/index.js'),
    ];
    expect(packagesFromModuleIds(ids, root)).toEqual([
      { name: '@scope/pkg', version: '2.0.0', path: 'node_modules/@scope/pkg' },
      { name: 'react', version: '19.0.0', path: 'node_modules/react' },
      { name: 'semver', version: '7.8.5', path: 'node_modules/sharp/node_modules/semver' },
    ]);
  });

  it('отбрасывает виртуальные модули, модули вне node_modules и пакеты без имени; дубли и query не множат записи', () => {
    const ids = [
      '\0vite/preload-helper',
      join(root, 'src/app.ts'),
      join(root, 'node_modules/noname/index.js'),
      join(root, 'node_modules/react/index.js'),
      `${join(root, 'node_modules/react/index.js')}?commonjs-proxy`,
      join(root, 'node_modules/react/index.js').replaceAll('\\', '/'),
    ];
    expect(packagesFromModuleIds(ids, root)).toEqual([
      { name: 'react', version: '19.0.0', path: 'node_modules/react' },
    ]);
  });

  it('пути — относительные, с прямыми слэшами', () => {
    const [only] = packagesFromModuleIds([join(root, 'node_modules/react/index.js')], root);
    expect(only?.path).toBe('node_modules/react');
    expect(only?.path).not.toContain('\\');
  });

  it('packageDirOf: модуль, лежащий прямо в node_modules, и пустой id — не пакет', () => {
    expect(packageDirOf(join(root, 'node_modules/react'))).toBeNull();
    expect(packageDirOf('')).toBeNull();
  });
});
