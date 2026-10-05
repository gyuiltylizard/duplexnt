import { readFileSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

// Единственный помощник путей к фикстурам (test/fixtures/README.md). Тесты и эмулятор не
// собирают путь строкой: переезд каталога правит один этот файл.

const FIXTURES_ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url));
const FIXTURES_REPO_DIR = 'test/fixtures';

/** Каталог устройства внутри фикстур: `<протокол>/<устройство>`. */
export const ET_3850 = ['escl', 'et-3850'] as const;

function checked(segments: readonly string[]): readonly string[] {
  for (const segment of segments) {
    if (segment === '' || isAbsolute(segment) || segment.split(/[\\/]/).includes('..')) {
      throw new Error(`путь к фикстуре выходит из каталога фикстур: ${segments.join('/')}`);
    }
  }
  return segments;
}

/** Абсолютный путь к фикстуре. */
export function fixturePath(...segments: string[]): string {
  return join(FIXTURES_ROOT, ...checked(segments));
}

/** Путь от корня репозитория с прямыми слэшами — для сообщений и стража приватности. */
export function fixtureRepoPath(...segments: string[]): string {
  return posix.join(FIXTURES_REPO_DIR, ...checked(segments).map((it) => it.replaceAll('\\', '/')));
}

/** Байты фикстуры как есть: git не конвертирует концы строк, prettier файлы не трогает. */
export function readFixture(...segments: string[]): Buffer {
  return readFileSync(fixturePath(...segments));
}

export function readFixtureText(...segments: string[]): string {
  return readFixture(...segments).toString('utf8');
}

/** Страница-фикстура устройства по номеру листа: `pages/page-NN.jpg`. */
export function pageFixture(number: number): Buffer {
  return readFixture(...ET_3850, 'pages', `page-${String(number).padStart(2, '0')}.jpg`);
}
