import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { aliases } from './tooling/aliases';
import { TEST_PROJECTS } from './tooling/test-projects';

// Три проекта — таблица в tooling/test-projects.ts. `test` называет `node` и `jsdom` поимённо
// (см. package.json): прогон по умолчанию затянул бы и интеграционные. Глобалы vitest выключены —
// describe/it/expect импортируются явно, поэтому продуктовым проектам TypeScript не нужны его
// ambient-типы. Алиасы — из общей таблицы: electron.vite.config.ts vitest не читает.
export default defineConfig({
  resolve: { alias: aliases },
  test: {
    projects: TEST_PROJECTS.map((project) => ({
      extends: true as const,
      plugins: project.environment === 'jsdom' ? [react()] : [],
      test: {
        name: project.name,
        environment: project.environment,
        include: [...project.include],
        ...(project.exclude === undefined ? {} : { exclude: [...project.exclude] }),
        ...(project.testTimeout === undefined ? {} : { testTimeout: project.testTimeout }),
      },
    })),
  },
});
