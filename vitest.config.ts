import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { aliases } from './tooling/aliases';

// Три проекта. `test` называет `node` и `jsdom` поимённо (см. package.json): прогон по
// умолчанию затянул бы и интеграционные. Глобалы vitest выключены — describe/it/expect
// импортируются явно, поэтому продуктовым проектам TypeScript не нужны его ambient-типы.
// Алиасы — из общей таблицы: electron.vite.config.ts vitest не читает.
export default defineConfig({
  resolve: { alias: aliases },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: ['src/renderer/**', 'test/integration/**'],
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/integration/**/*.test.ts'],
        },
      },
    ],
  },
});
