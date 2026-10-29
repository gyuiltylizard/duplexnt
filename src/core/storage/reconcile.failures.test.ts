import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dirSnapshot } from '../../../test/support/dir-snapshot';
import { fsError, interceptFs } from '../../../test/support/intercept-fs';
import {
  journalOf,
  ORIGIN,
  OTHER_SESSION,
  page,
  pageName,
  pagesOfFirstSegment,
  pass,
  reconciled,
  seed,
  segment,
} from '../../../test/support/reconcile';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import { openSessionStore, reconcileSession } from './reconcile';
import { realStorageFs } from './storage-fs';

// «Процесс убит» на каждом шаге записи хранилища: сверка после сбоя не теряет принятое, не
// возвращает удалённое и идемпотентна. Выделено из `reconcile.test.ts` по правилу размера
// тестового файла.

describe('сверка при запуске: сбой на каждом шаге записи хранилища', () => {
  const READS = new Set(['readdir', 'readFile', 'size', 'freeBytes']);

  // «Процесс убит» на шаге N: этот и все следующие изменения диска не выполняются.
  function dyingFs(dieAt: number) {
    let step = 0;
    let dead = false;
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (dead) {
        throw fsError('ECRASH');
      }
      if (!READS.has(call.op)) {
        step += 1;
        if (step === dieAt) {
          dead = true;
          throw fsError('ECRASH');
        }
      }
    });
    return { fs, steps: () => step, dead: () => dead };
  }

  async function* body(number: number): AsyncGenerator<Uint8Array> {
    await Promise.resolve();
    yield page(number);
  }

  interface Outcome {
    /** Страницы, приём которых подтверждён и которые никто не удалял: ключ → принятые байты. */
    readonly kept: Map<string, Uint8Array>;
    /** Страницы сегмента, удаление которого подтверждено. */
    readonly discarded: Set<string>;
    /** Страницы сегмента, удаление которого началось, но не подтверждено: все или ни одной. */
    readonly limbo: Set<string>;
    closing: boolean;
  }

  // Сценарий: проход, обрыв, досканирование, «Остановить», новое досканирование, второй проход,
  // «оставить как есть», «Новая пачка».
  async function scenario(root: string, fs: typeof realStorageFs): Promise<Outcome> {
    const outcome: Outcome = {
      kept: new Map(),
      discarded: new Set(),
      limbo: new Set(),
      closing: false,
    };
    const { store } = await openSessionStore(root, { fs, retry: { ceilingMs: 0 } });
    const must = <T>(result: { ok: true; value: T } | { ok: false }): T => {
      if (!result.ok) {
        throw new Error('операция отклонена');
      }
      return result.value;
    };
    let content = 0;
    const accept = async (count: number, into?: Set<string>): Promise<void> => {
      for (let index = 0; index < count; index += 1) {
        content += 1;
        const { key } = await store.acceptPage(body(content));
        if (into === undefined) {
          outcome.kept.set(key, page(content));
        } else {
          into.add(key);
        }
      }
    };

    try {
      must(await store.beginPass(ORIGIN, null));
      await accept(3);
      must(await store.endSegment('interrupted'));

      must(await store.resumePass());
      const stopped = new Set<string>();
      await accept(2, stopped);
      stopped.forEach((key) => outcome.limbo.add(key));
      must(await store.discardSegment());
      outcome.limbo.clear();
      stopped.forEach((key) => outcome.discarded.add(key));

      must(await store.resumePass());
      await accept(2);
      must(await store.endSegment('completed'));

      must(await store.beginPass(ORIGIN, null));
      await accept(1);
      must(await store.endSegment('interrupted'));
      must(await store.acceptPass());

      outcome.closing = true;
      must(await store.closeSession());
    } catch {
      // Процесс «убит»: дальше — только сверка.
    }
    return outcome;
  }

  it('после каждого сбоя сверка проводится дважды: полученное не потеряно, удалённое не вернулось, второй прогон ничего не меняет', async () => {
    const dryRoot = await makeTempDataRoot();
    const dry = dyingFs(Number.POSITIVE_INFINITY);
    await scenario(dryRoot, dry.fs);
    const total = dry.steps();
    expect(total).toBeGreaterThan(60);

    for (let dieAt = 1; dieAt <= total; dieAt += 1) {
      const root = await makeTempDataRoot();
      const dying = dyingFs(dieAt);
      const outcome = await scenario(root, dying.fs);
      expect(dying.dead(), `шаг ${dieAt}`).toBe(true);

      const first = await reconciled(root);
      const afterFirst = await dirSnapshot(root);
      const second = await reconciled(root);

      expect(await dirSnapshot(root), `шаг ${dieAt}: второй прогон`).toEqual(afterFirst);
      expect(second.keys, `шаг ${dieAt}: второй прогон`).toEqual(first.keys);
      expect(second.lost, `шаг ${dieAt}`).toEqual([]);

      const present = new Set(first.keys);
      // «Новая пачка» оборвана: сессия либо цела, либо её нет — половины не бывает.
      if (!outcome.closing || present.size > 0) {
        for (const [key, bytes] of outcome.kept) {
          expect(present.has(key), `шаг ${dieAt}: страница ${key} потеряна`).toBe(true);
          // Не только имя: байты на диске — те, что были приняты.
          expect(await second.store.readPage(key), `шаг ${dieAt}: страница ${key}`).toEqual({
            ok: true,
            value: bytes,
          });
        }
      }
      for (const key of outcome.discarded) {
        expect(present.has(key), `шаг ${dieAt}: страница ${key} вернулась`).toBe(false);
      }
      const limbo = [...outcome.limbo].filter((key) => present.has(key));
      expect([0, outcome.limbo.size], `шаг ${dieAt}: удаление наполовину`).toContain(limbo.length);
    }
  }, 120_000);
  // Сама сверка тоже может быть убита посередине: следующий запуск обязан довести её до того же.
  it.each([
    [
      'журнал с идущим сегментом, пометкой об удалении, временными файлами и закрываемым каталогом',
      journalOf([pass(1, [segment(1, 'running', 2)], { nextSegment: 3 })], {
        deletions: ['p01-s02-'],
      }),
    ],
    ['нечитаемый журнал', 'не журнал'],
  ])(
    'сверка, убитая на каждом своём шаге, доводится следующими запусками: %s',
    async (_title, journal) => {
      const prepare = async () => {
        const seeded = await seed(journal, [
          ...pagesOfFirstSegment(3),
          ...(typeof journal === 'string' ? [] : [pageName(1, 2, 1), pageName(1, 2, 2)]),
        ]);
        const { root, layout } = seeded;
        await writeFile(join(layout.pagesDir, 'p01-s01-0004.jpg.0123456789ab.tmp'), page(4));
        await writeFile(join(layout.sessionDir, 'session.json.ba9876543210.tmp'), '{');
        await mkdir(join(root, `session.closing-${OTHER_SESSION}`, 'pages'), { recursive: true });
        await writeFile(
          join(root, `session.closing-${OTHER_SESSION}`, 'pages', pageName(1, 1, 1)),
          page(1),
        );
        await mkdir(join(layout.derivedDir, OTHER_SESSION, 'thumbs'), { recursive: true });
        return seeded;
      };
      const expectedKeys = ['p01-s01-0001', 'p01-s01-0002', 'p01-s01-0003'];

      const dry = dyingFs(Number.POSITIVE_INFINITY);
      await reconcileSession((await prepare()).root, { fs: dry.fs, retry: { ceilingMs: 0 } });
      const total = dry.steps();
      expect(total).toBeGreaterThan(5);

      for (let dieAt = 1; dieAt <= total; dieAt += 1) {
        const { root, layout } = await prepare();
        const dying = dyingFs(dieAt);
        await reconcileSession(root, { fs: dying.fs, retry: { ceilingMs: 0 } }).catch(
          () => undefined,
        );
        expect(dying.dead(), `шаг ${dieAt}`).toBe(true);

        const first = await reconciled(root);
        const afterFirst = await dirSnapshot(root);
        const second = await reconciled(root);

        expect(first.keys, `шаг ${dieAt}`).toEqual(expectedKeys);
        expect(first.lost, `шаг ${dieAt}`).toEqual([]);
        expect(first.passes[0]?.state, `шаг ${dieAt}`).toBe('interrupted');
        expect(second.keys, `шаг ${dieAt}: второй прогон`).toEqual(expectedKeys);
        expect(await dirSnapshot(root), `шаг ${dieAt}: второй прогон`).toEqual(afterFirst);
        // Страницы отброшенного сегмента не вернулись, временные файлы не стали страницами.
        expect(await readdir(layout.pagesDir), `шаг ${dieAt}`).toEqual(pagesOfFirstSegment(3));
        if (typeof journal === 'string') {
          // Нечитаемый журнал не потерян, сколько бы раз сверка ни начиналась заново.
          const copies = (await readdir(layout.sessionDir)).filter((name) =>
            name.includes('.unreadable-'),
          );
          expect(copies, `шаг ${dieAt}`).toHaveLength(1);
          expect(await readFile(join(layout.sessionDir, copies[0] ?? ''), 'utf8')).toBe(journal);
        }
      }
    },
    120_000,
  );
});
