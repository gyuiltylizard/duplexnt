import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Метаданные публичной сборки (B-40, U1). Версия и лицензия живут только в package.json:
// electron-builder берёт из них имя установщика, свойства exe и издателя, GitHub — лицензию в
// шапке репозитория. Регрессия к `0.0.0` или потеря поля `license` незаметна ни сборке, ни
// запуску — её держит этот тест.

interface PackageMetadata {
  readonly version: string;
  readonly license?: string;
  readonly description?: string;
  readonly author?: string | { readonly name?: string };
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as PackageMetadata;

describe('package.json — метаданные публичной сборки (B-40)', () => {
  it('версия — semver с необязательным суффиксом beta.N / rc.N, не 0.0.0', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-(beta|rc)\.\d+)?$/);
    expect(pkg.version).not.toBe('0.0.0');
  });

  it('лицензия — GPL-3.0-only (решение автора 2026-11-05, ADR 0009)', () => {
    expect(pkg.license).toBe('GPL-3.0-only');
  });

  it('описание — по-английски: оно идёт в свойства установщика (KTD-8)', () => {
    expect(pkg.description).toBeTruthy();
    expect(pkg.description).not.toMatch(/[А-Яа-яЁё]/);
  });

  it('автор — объект с именем: издатель в свойствах exe', () => {
    expect(typeof pkg.author).toBe('object');
    expect((pkg.author as { name?: string }).name).toBeTruthy();
  });
});

describe('LICENSE (B-40)', () => {
  it('в корне лежит текст GPL версии 3', () => {
    expect(existsSync('LICENSE')).toBe(true);
    const text = readFileSync('LICENSE', 'utf8');
    expect(text.trimStart().startsWith('GNU GENERAL PUBLIC LICENSE')).toBe(true);
    expect(text).toContain('Version 3, 29 June 2007');
  });

  it('в build/ нет license.* и eula.*: electron-builder добавил бы страницу «I agree» (KTD-2)', () => {
    const stray = readdirSync('build').filter((name) => /^(license|eula)\./i.test(name));
    expect(stray).toEqual([]);
  });
});
