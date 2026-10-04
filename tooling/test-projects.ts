// Единственная таблица тестовых прогонов: её читают vitest.config.ts и страж
// test/guards/test-projects.test.ts. Тестовый файл, не попавший ни в один проект, vitest молча
// не запускает — страж превращает это в упавший тест.
//
// Пути — от корня репозитория, с прямыми слэшами.

export interface TestProject {
  readonly name: 'node' | 'jsdom' | 'integration';
  readonly environment: 'node' | 'jsdom';
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
}

export const TEST_PROJECTS: readonly TestProject[] = [
  {
    name: 'node',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['src/renderer/**', 'test/integration/**'],
  },
  {
    name: 'jsdom',
    environment: 'jsdom',
    include: ['src/renderer/**/*.test.{ts,tsx}'],
  },
  {
    name: 'integration',
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
  },
];
