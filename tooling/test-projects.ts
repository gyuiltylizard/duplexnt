// Единственная таблица тестовых прогонов: её читают vitest.config.ts и страж
// test/guards/test-projects.test.ts. Тестовый файл, не попавший ни в один проект, vitest молча
// не запускает — страж превращает это в упавший тест.
//
// Пути — от корня репозитория, с прямыми слэшами.

export interface TestProject {
  readonly name: 'node' | 'jsdom' | 'integration' | 'worst-case' | 'design';
  readonly environment: 'node' | 'jsdom';
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
  /** Срок одного теста, мс; без поля — дефолт vitest (5 с). */
  readonly testTimeout?: number;
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
  // Эмуляторные тесты гонят подачу в реальном времени, а ожидание `until` рассчитано на 10 с:
  // дефолтных 5 с под нагрузкой (рядом работает приложение) не хватало, и тесты падали по
  // таймауту vitest раньше, чем `until` сказал бы, чего не дождался. Общий срок 20 с — тот, что
  // раньше выставляли точечно; тесты дольше (коррекция, 60–120 с) держат свой.
  {
    name: 'integration',
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    exclude: ['test/integration/**/*-worst-case.test.ts'],
    testTimeout: 20_000,
  },
  // Замеры памяти и пауз цикла событий на худшем объёме (PDF — KTD-12 M2, коррекция — ADR 0008):
  // пороги — триггеры решений, поэтому файлы идут по одному, без соседей на тех же ядрах
  // (`--no-file-parallelism` в скрипте `test:integration`); в общем прогоне чанк коррекции
  // 600 dpi цвет вырастал с 16 до 63 мс только от соседей.
  {
    name: 'worst-case',
    environment: 'node',
    include: ['test/integration/**/*-worst-case.test.ts'],
  },
  // Снимок интерфейса для дизайн-агента (B-6): пишет в docs/design/reference/, поэтому ни в
  // `test`, ни в `test:all` не входит — только `npm run design:snapshot`.
  {
    name: 'design',
    environment: 'jsdom',
    include: ['test/design-snapshot/**/*.test.tsx'],
  },
];
