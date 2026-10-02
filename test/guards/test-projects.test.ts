import { readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEST_PROJECTS, type TestProject } from '../../tooling/test-projects';

// Тестовый файл вне всех проектов vitest молча не запускается (находка ревью M0). Страж
// перечисляет тестовые файлы репозитория и требует, чтобы каждый попадал в проект.

const SKIPPED_DIRS = new Set([
  'node_modules',
  'out',
  'dist',
  'release',
  'temp',
  'local-test-data',
  'coverage',
]);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function listTestFiles(directory = '.'): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      // Каталоги с точкой — служебные (.git, .husky, .claude с копиями репозитория).
      return SKIPPED_DIRS.has(entry.name) || entry.name.startsWith('.') ? [] : listTestFiles(path);
    }
    return TEST_FILE.test(entry.name) ? [path] : [];
  });
}

const projectsOf = (file: string, projects: readonly TestProject[]): string[] =>
  projects
    .filter(
      (project) =>
        project.include.some((glob) => posix.matchesGlob(file, glob)) &&
        !(project.exclude ?? []).some((glob) => posix.matchesGlob(file, glob)),
    )
    .map((project) => project.name);

const orphans = (files: readonly string[], projects: readonly TestProject[]): string[] =>
  files.filter((file) => projectsOf(file, projects).length === 0);

describe('тестовые прогоны', () => {
  const files = listTestFiles();

  it('каждый тестовый файл репозитория попадает в проект vitest', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(orphans(files, TEST_PROJECTS)).toEqual([]);
  });

  it('ни один файл не попадает в два проекта: тест не идёт дважды', () => {
    expect(files.filter((file) => projectsOf(file, TEST_PROJECTS).length > 1)).toEqual([]);
  });

  it('проекты разведены по назначению', () => {
    expect(projectsOf('src/core/storage/atomic-file.test.ts', TEST_PROJECTS)).toEqual(['node']);
    expect(projectsOf('src/renderer/src/App.test.tsx', TEST_PROJECTS)).toEqual(['jsdom']);
    expect(projectsOf('src/renderer/src/state/store.test.ts', TEST_PROJECTS)).toEqual(['jsdom']);
    expect(projectsOf('test/integration/imaging-probe.test.ts', TEST_PROJECTS)).toEqual([
      'integration',
    ]);
  });

  it('скрипты package.json называют каждый проект, и только существующие', () => {
    // Проекты перечислены в скриптах поимённо: новый проект без строки в скрипте не запустился бы.
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const named = [scripts.test, scripts['test:integration']].flatMap((script) =>
      [...(script ?? '').matchAll(/--project (\S+)/g)].map((match) => match[1]),
    );

    expect(named.sort()).toEqual(TEST_PROJECTS.map((project) => project.name).sort());
  });

  it('тестовый файл вне всех проектов ловится', () => {
    const synthetic = [
      'scripts/privacy-guard.test.ts',
      'tooling/csp.test.ts',
      'src/main/window.test.tsx',
      'test/emulator/server.spec.ts',
      'spikes/escl.test.mjs',
    ];

    expect(orphans(synthetic, TEST_PROJECTS)).toEqual(synthetic);
    expect(orphans(['test/emulator/server.test.ts'], TEST_PROJECTS)).toEqual([]);
  });
});
