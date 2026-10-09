import { readdir, readFile } from 'node:fs/promises';
import { interceptFs, type FsCall } from './intercept-fs';
import { unwrap } from './result';
import { makeTempDataRoot } from './temp-data-root';
import { parseJournal, type Journal, type PassOrigin } from '../../src/core/storage/journal';
import { layoutOf } from '../../src/core/storage/layout';
import { createSessionStore, type SessionStoreOptions } from '../../src/core/storage/session-store';
import { realStorageFs } from '../../src/core/storage/storage-fs';

// Общие хелперы тестов хранилища сессии (`src/core/storage/session-store*.test.ts`) — посев,
// приём страниц, журнал с диска. Живут здесь, а не рядом с тестами: продуктовым файлам src/
// импорт из test/ закрыт, а хелперам нужен перехват ФС. Тесты поделены по смыслу на несколько файлов (правило размера тестового файла):
// `session-store.test.ts` — проход, досканирование, отказы и сбои записи;
// `session-store.lifecycle.test.ts` — закрытие, пустая сессия, потолки, сверка с нечитаемым;
// `session-store.flags.test.ts` — флаги журнала, правки редактора, роли проходов.

export const SESSION = 'a1b2c3d4e5f60718';

export const ORIGIN: PassOrigin = {
  scanner: {
    scheme: 'https',
    host: 'scanner.test',
    port: 443,
    basePath: '/eSCL',
    fingerprint: 'ab'.repeat(32),
    uuid: '00000000-0000-4000-8000-000000000001',
    name: 'Test Scanner',
  },
  params: { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' },
  pixelLimit: 5100 * 8400,
};

// Содержимое страницы хранилищу безразлично: маркеры JPEG проверяет задание (U10).
export const page = (number: number): Uint8Array =>
  Uint8Array.of(0xff, 0xd8, number, number, 0xff, 0xd9);

export async function* body(...chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    await Promise.resolve();
    yield chunk;
  }
}

/** Разворачивает успех конверта (тот же `unwrap`, короткое имя в тестах хранилища). */
export const ok = unwrap;

/** Роли проходов в сравнимом виде: `[номер, роль, якорь]`. */
export const rolesOf = (
  passes: readonly {
    readonly number: number;
    readonly kind: string;
    readonly after: string | null;
  }[],
): (string | number | null)[][] => passes.map((pass) => [pass.number, pass.kind, pass.after]);

/** Журнал сессии с диска; нечитаемый — падение теста. */
export async function journalOnDisk(root: string): Promise<Journal> {
  const parsed = parseJournal(await readFile(layoutOf(root).journalFile));
  if (parsed.kind !== 'ok') {
    throw new Error(`журнал на диске не читается: ${parsed.kind}`);
  }
  return parsed.value;
}

export async function setup(before?: (call: FsCall) => void, options: SessionStoreOptions = {}) {
  const root = await makeTempDataRoot();
  const layout = layoutOf(root);
  const { fs, calls } = interceptFs(realStorageFs, before);
  const store = createSessionStore(root, undefined, {
    fs,
    newSessionId: () => SESSION,
    retry: { ceilingMs: 0 },
    ...options,
  });

  const pageFiles = async (): Promise<string[]> =>
    (await readdir(layout.pagesDir).catch(() => [])).sort();
  const journalOnDiskHere = (): Promise<Journal> => journalOnDisk(root);
  /** Принимает страницы с номерами содержимого `from…to` в идущий сегмент. */
  const accept = async (from: number, to: number): Promise<void> => {
    for (let number = from; number <= to; number += 1) {
      await store.acceptPage(body(page(number)));
    }
  };
  return { root, layout, store, calls, pageFiles, journalOnDisk: journalOnDiskHere, accept };
}

export const isJournalRename = (call: FsCall): boolean =>
  call.op === 'rename' && call.to?.endsWith('session.json') === true;
