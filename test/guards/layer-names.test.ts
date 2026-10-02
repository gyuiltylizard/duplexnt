import { mkdirSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDataRoot } from '../support/temp-data-root';

// Имена слоёв зарезервированы (план M1, KTD-3). Границы слоёв в eslint.config.ts узнают слой по
// имени каталога в относительном пути: папка `main` внутри renderer дала бы ложное срабатывание.
// Дешевле запретить такие имена, чем переводить правило на резолвер.

const LAYER_NAMES = new Set(['shared', 'core', 'main', 'preload', 'renderer', 'locales']);

// Каталоги с именем слоя глубже первого уровня `src/`. Пути — от `srcRoot`, с прямыми слэшами.
function nestedLayerDirs(srcRoot: string, relative = ''): string[] {
  return readdirSync(join(srcRoot, relative), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const path = posix.join(relative, entry.name);
      const here = relative !== '' && LAYER_NAMES.has(entry.name) ? [path] : [];
      return [...here, ...nestedLayerDirs(srcRoot, path)];
    });
}

describe('имена слоёв', () => {
  it('в src/ нет вложенных каталогов с именем слоя', () => {
    expect(nestedLayerDirs('src')).toEqual([]);
  });

  it('первый уровень src/ — сами слои, они не считаются', () => {
    expect(readdirSync('src').sort()).toEqual(['core', 'main', 'preload', 'renderer', 'shared']);
  });

  it('синтетический каталог src/renderer/src/main/ ловится', async () => {
    const src = await makeTempDataRoot();
    mkdirSync(join(src, 'renderer', 'src', 'main'), { recursive: true });
    mkdirSync(join(src, 'renderer', 'src', 'screens'), { recursive: true });
    mkdirSync(join(src, 'core', 'storage', 'core'), { recursive: true });
    mkdirSync(join(src, 'main', 'shell'), { recursive: true });

    expect(nestedLayerDirs(src).sort()).toEqual(['core/storage/core', 'renderer/src/main']);
  });

  it('каталог с похожим именем слоем не считается', async () => {
    const src = await makeTempDataRoot();
    mkdirSync(join(src, 'core', 'main-loop'), { recursive: true });
    mkdirSync(join(src, 'renderer', 'src', 'shared-ui'), { recursive: true });

    expect(nestedLayerDirs(src)).toEqual([]);
  });
});
