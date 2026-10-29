import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StraightenStatus } from '../../src/shared';
import type { PassService } from '../../src/core/scan/pass-service';
import { layoutOf } from '../../src/core/storage/layout';
import { pdfImageStreams } from './fixtures';

// Помощники эмуляторных тестов выравнивания (M6): каталоги производного сессии, статусы снимка,
// потоки картинок PDF и выправленные файлы на диске.

export const sessionIdOf = (service: PassService): string => service.snapshot().session?.id ?? '';

export const straightDirOf = (root: string, sessionId: string): string =>
  join(layoutOf(root).derivedDir, sessionId, 'straight');

export const skewDirOf = (root: string, sessionId: string): string =>
  join(layoutOf(root).derivedDir, sessionId, 'skew');

/** Ключ → статус выравнивания по всей ленте снимка, скрытые включительно. */
export const statusesOf = (service: PassService): Record<string, StraightenStatus> =>
  Object.fromEntries(
    (service.snapshot().assembly?.order ?? []).map((page) => [page.key, page.straighten.status]),
  );

/** Потоки картинок страниц PDF по порядку. */
export const streamsOf = async (pdf: string): Promise<Buffer[]> =>
  (await pdfImageStreams(await readFile(pdf))).map((stream) => Buffer.from(stream.getContents()));

/** Имена JPEG в каталоге по алфавиту; каталога нет — пусто. */
export const jpegsIn = async (dir: string): Promise<string[]> =>
  (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.jpg')).sort();
