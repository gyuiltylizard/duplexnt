import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';

// Страж одной истины по выправленным файлам (план M6, U11; KTD-11): путь к выправленному JPEG
// всем потребителям — протоколу картинок, миниатюрам, снимку PDF — отдаёт только
// `straightened.resolve`. Прямое обращение к каталогу (`straightDirIn(` / `straightDirOf(`) вне
// модуля выправленных файлов, раскладки и путей очистки (`removeMarked`, сверка) — красный тест:
// второй писатель или читатель мимо записи о коррекции отдал бы сироту за выправленную страницу.

const ALLOWED = new Set([
  'core/storage/layout.ts',
  'core/storage/straightened.ts',
  'core/storage/session-store.ts',
  'core/storage/reconcile.ts',
]);

const DIRECT_ACCESS = /\bstraightDir(?:In|Of)\(/;

/** Файлы `src/` (без тестов), где каталог выправленных берётся напрямую; пути с прямыми слэшами. */
function directAccessors(srcRoot: string, relative = ''): string[] {
  return readdirSync(join(srcRoot, relative), { withFileTypes: true }).flatMap((entry) => {
    const path = posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      return directAccessors(srcRoot, path);
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) {
      return [];
    }
    return DIRECT_ACCESS.test(readFileSync(join(srcRoot, relative, entry.name), 'utf8'))
      ? [path]
      : [];
  });
}

describe('выправленные файлы: один источник пути', () => {
  it('каталог straight/ берут напрямую только модуль выправленных, раскладка и очистка', () => {
    const outsiders = directAccessors('src').filter((path) => !ALLOWED.has(path));
    expect(outsiders).toEqual([]);
  });

  it('разрешённые места действительно к нему обращаются — страж не пуст', () => {
    expect(directAccessors('src').sort()).toEqual([...ALLOWED].sort());
  });

  it('синтетический потребитель мимо resolve ловится', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { makeTempDataRoot } = await import('../support/temp-data-root');
    const src = await makeTempDataRoot();
    await mkdir(join(src, 'main'), { recursive: true });
    await writeFile(
      join(src, 'main', 'page-protocol.ts'),
      'const dir = straightDirIn(derived, id); // мимо resolve\n',
    );
    await writeFile(join(src, 'main', 'page-protocol.test.ts'), 'straightDirIn(');
    await writeFile(join(src, 'main', 'events.ts'), 'export const x = 1;\n');

    expect(directAccessors(src)).toEqual(['main/page-protocol.ts']);
  });
});
