import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Каталог побайтово: путь с прямыми слэшами → содержимое в hex; каталоги — отдельной отметкой.
 * Два снимка равны тогда и только тогда, когда в каталоге не изменился ни один байт и ни одно имя.
 */
export async function dirSnapshot(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    const path = join(root, name);
    snapshot[name.replaceAll('\\', '/')] = (await stat(path)).isDirectory()
      ? '<каталог>'
      : (await readFile(path)).toString('hex');
  }
  return snapshot;
}
