import { readFileSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from '@cantoo/pdf-lib';

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

/** Сколько страниц-фикстур у устройства. */
export const PAGE_FIXTURES = 30;

const pageFixtures = new Map<number, Buffer>();

/**
 * Номер страницы-фикстуры по байтам: JPEG вкладывается в PDF как есть (`DCTDecode`), так что
 * поток изображения равен фикстуре байт в байт. Не фикстура — ошибка.
 */
export function pageFixtureNumberOf(bytes: Uint8Array): number {
  const buffer = Buffer.from(bytes);
  for (let number = 1; number <= PAGE_FIXTURES; number += 1) {
    let fixture = pageFixtures.get(number);
    if (fixture === undefined) {
      fixture = pageFixture(number);
      pageFixtures.set(number, fixture);
    }
    if (fixture.equals(buffer)) {
      return number;
    }
  }
  throw new Error('байты не совпадают ни с одной страницей-фикстурой');
}

/** Потоки изображений документа — по страницам, в их порядке, без декодирования фильтров. */
export async function pdfImageStreams(pdfBytes: Uint8Array): Promise<PDFRawStream[]> {
  const document = await PDFDocument.load(pdfBytes);
  const streams: PDFRawStream[] = [];
  for (const page of document.getPages()) {
    const xobjects = page.node.Resources()?.lookup(PDFName.of('XObject'));
    if (!(xobjects instanceof PDFDict)) {
      continue;
    }
    for (const [, value] of xobjects.entries()) {
      const stream = page.node.context.lookup(value);
      if (stream instanceof PDFRawStream) {
        streams.push(stream);
      }
    }
  }
  return streams;
}
