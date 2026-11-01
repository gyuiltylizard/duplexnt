import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';

// Страж одного входа в `sharp` (B-21, план 2026-11-01-001, KTD-1, KTD-7): каждая обработка
// страницы пользователя идёт через `processImage` с двумя сроками. Импорт `sharp` в `src/` вне
// помощника и пробы окружения — красный тест: новый вызов мимо помощника снова мог бы зависнуть
// навсегда. Формы импорта — как у `dynamicImportSelectors` в `eslint.config.ts`: статический,
// `import()`, `require()`. Правило lint не годится: блок `no-restricted-imports` перекрыл бы
// ограничения слоёв для тех же файлов.

const ALLOWED = new Set([
  'core/image/sharp-image.ts',
  // Проба окружения при запуске: синтетическая картинка, не страница пользователя.
  'core/probe/imaging-probe.ts',
]);

const SHARP_IMPORT =
  /(?:\bfrom\s*['"]sharp['"]|\bimport\s*\(\s*['"]sharp['"]\s*\)|\brequire\s*\(\s*['"]sharp['"]\s*\)|^\s*import\s*['"]sharp['"])/m;

/** Файлы `src/` (без тестов), где подключается `sharp`; пути с прямыми слэшами. */
function sharpImporters(srcRoot: string, relative = ''): string[] {
  return readdirSync(join(srcRoot, relative), { withFileTypes: true }).flatMap((entry) => {
    const path = posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      return sharpImporters(srcRoot, path);
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) {
      return [];
    }
    return SHARP_IMPORT.test(readFileSync(join(srcRoot, relative, entry.name), 'utf8'))
      ? [path]
      : [];
  });
}

describe('sharp: один вход со сроками', () => {
  it('sharp подключают только помощник обработки и проба окружения', () => {
    const outsiders = sharpImporters('src').filter((path) => !ALLOWED.has(path));
    expect(outsiders).toEqual([]);
  });

  it('разрешённые места действительно его подключают — страж не пуст', () => {
    expect(sharpImporters('src').sort()).toEqual([...ALLOWED].sort());
  });

  it('синтетические обходы — статический, динамический импорт и require — ловятся', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { makeTempDataRoot } = await import('../support/temp-data-root');
    const src = await makeTempDataRoot();
    await mkdir(join(src, 'core'), { recursive: true });
    await writeFile(join(src, 'core', 'static.ts'), "import sharp from 'sharp';\n");
    await writeFile(join(src, 'core', 'named.ts'), 'import { type Sharp } from "sharp";\n');
    await writeFile(join(src, 'core', 'dynamic.ts'), "const s = await import('sharp');\n");
    await writeFile(join(src, 'core', 'required.ts'), "const s = require( 'sharp' );\n");
    await writeFile(join(src, 'core', 'side.ts'), "import 'sharp';\n");
    await writeFile(join(src, 'core', 'page.test.ts'), "import sharp from 'sharp';\n");
    await writeFile(join(src, 'core', 'other.ts'), "import x from 'sharp-extra';\n// sharp\n");

    expect(sharpImporters(src).sort()).toEqual(
      [
        'core/dynamic.ts',
        'core/named.ts',
        'core/required.ts',
        'core/side.ts',
        'core/static.ts',
      ].sort(),
    );
  });
});
