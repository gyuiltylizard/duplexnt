import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { onTestFinished } from 'vitest';

// Временный корень данных для теста (план M1, R20): тесты не касаются настоящего каталога данных
// приложения. Каталог создаётся в системном temp и убирается по окончании теста, который его
// завёл. Вызывать изнутри `it(...)`.
export async function makeTempDataRoot(): Promise<string> {
  const base = await realpath(tmpdir());
  const root = await mkdtemp(join(base, 'duplexnt-test-'));

  // Страховка от ошибки в самом помощнике: удалять рекурсивно можно только то, что лежит в temp.
  const inside = relative(base, root);
  if (inside === '' || inside.startsWith('..') || inside.includes(sep)) {
    throw new Error(`временный корень вне системного temp: ${root}`);
  }

  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return root;
}
