import { resolve } from 'node:path';

// Единственная таблица алиасов сборки: её читают electron.vite.config.ts и vitest.config.ts.
// Ещё два места, где алиасы повторяются руками, — `paths` в tsconfig.base.json и паттерны
// границ слоёв в eslint.config.ts. Меняешь здесь — поменяй там.
//
// Корень берётся от рабочего каталога: все команды проекта запускаются из корня репозитория,
// а конфиги бандлятся загрузчиками в разные форматы, где `__dirname` и `import.meta` ведут
// себя по-разному.
const root = process.cwd();

export const aliases: Record<string, string> = {
  '@shared': resolve(root, 'src/shared'),
  '@core': resolve(root, 'src/core'),
  '@locales': resolve(root, 'locales'),
};
