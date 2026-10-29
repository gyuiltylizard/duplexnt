import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EMPTY_EDITS, fail, NO_VERDICTS, type StraightenFacts } from '@shared';
import { describe, expect, it } from 'vitest';
import { pageFixture } from '../../../test/support/fixtures';
import { fsError, interceptFs } from '../../../test/support/intercept-fs';
import { seedSession } from '../../../test/support/pass-service-seed';
import { unwrap } from '../../../test/support/result';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import { openSessionStore } from '../storage/reconcile';
import { ioOf, realStorageFs } from '../storage/storage-fs';
import type { StraightenedFile } from '../storage/straightened';
import { assembleSession } from './assembly';
import { createDocumentWriter } from './save-flow';

// Пакет сохранения по снимку выправленных (план M6, U12; KTD-8; AE14) на настоящем хранилище
// сессии и подставных выправленных файлах: повтор пакета при сменившемся дайджесте снимка —
// отказ `batchStale` при неизменном журнале; на время записи прежние версии удерживаются
// (ревью сессий 3–4). Остальные гарды пакета — `pass-service.save.test.ts`.

const F1 = 'p01-s01-0001';

async function setup() {
  const root = await makeTempDataRoot();
  await seedSession(root, [{ number: 1, pages: 2, fixtures: [1, 2] }]);
  const folder = join(root, 'выход');
  await mkdir(folder, { recursive: true });
  const { store } = await openSessionStore(root);
  unwrap(await store.setEdits({ ...EMPTY_EDITS, cuts: [1], names: ['A', 'B'] }, {}));
  // Выправленный файл первой страницы — любой JPEG, отличный от исходника; размер — в записи.
  const straightDir = join(root, 'straight');
  await mkdir(straightDir, { recursive: true });
  const fileOf = async (fixture: number): Promise<StraightenedFile> => {
    const path = join(straightDir, `${F1}.f${String(fixture)}.jpg`);
    const bytes = pageFixture(fixture);
    await writeFile(path, bytes);
    return { path, version: 1, bytes: bytes.byteLength, encoding: 'jpeg-q92-444', dpi: 300 };
  };
  let current = await fileOf(3);
  const holds: string[] = [];
  let failSecond = false;
  const { fs } = interceptFs(realStorageFs, (call) => {
    if (failSecond && call.op === 'rename' && call.to?.endsWith('B.pdf') === true) {
      throw fsError('EIO');
    }
  });
  const straightened = {
    resolve: (key: string) => (key === F1 ? current : null),
    read: async (file: StraightenedFile) => {
      try {
        return { ok: true as const, value: await realStorageFs.readFile(file.path) };
      } catch {
        return fail('pageUnavailable', { reason: 'straightened' });
      }
    },
    hold: () => {
      holds.push('hold');
      return () => {
        holds.push('release');
      };
    },
  };
  const facts = (): StraightenFacts =>
    new Map([
      [F1, { outcome: 'willStraighten', version: current.version, deferred: null, cause: null }],
      ['p01-s01-0002', { outcome: 'level', version: null, deferred: null, cause: null }],
    ]);
  const writer = createDocumentWriter({
    store,
    assemble: (session) =>
      assembleSession({ ...session, straighten: 'auto' }, NO_VERDICTS, facts()),
    straightened,
    io: ioOf({ fs }),
    onSaved: () => undefined,
  });
  return {
    folder,
    writer,
    holds,
    setFailSecond: (value: boolean) => {
      failSecond = value;
    },
    replaceFile: async (fixture: number) => {
      current = await fileOf(fixture);
    },
  };
}

const SEPARATE = { mode: 'separate', names: ['A', 'B'], retry: false } as const;

describe('пакет по снимку выправленных (KTD-8)', () => {
  it('на время записи прежние версии удерживаются: hold до сборки, release после — и при сбое файла', async () => {
    const { folder, writer, holds, setFailSecond } = await setup();
    setFailSecond(true);

    const first = unwrap(await writer.write(folder, SEPARATE));

    expect(first.written).toEqual([{ index: 0, fileName: 'A.pdf' }]);
    expect(first.failed.map((file) => file.index)).toEqual([1]);
    expect(holds).toEqual(['hold', 'release']);
  });

  it('AE14: повтор после смены выправленного файла при том же журнале — batchStale, пакет заново целиком', async () => {
    const { folder, writer, setFailSecond, replaceFile } = await setup();
    setFailSecond(true);
    expect(unwrap(await writer.write(folder, SEPARATE)).failed).toHaveLength(1);
    setFailSecond(false);

    // Поздняя коррекция: у первой страницы другой файл того же статуса — дайджест снимка иной.
    await replaceFile(4);

    expect(await writer.write(folder, { ...SEPARATE, retry: true })).toEqual(
      fail('sessionConflict', { reason: 'batchStale' }),
    );
    // Незавершённый пакет забыт: повторять нечего.
    expect(await writer.write(folder, { ...SEPARATE, retry: true })).toEqual(
      fail('sessionConflict', { reason: 'noFailedFiles' }),
    );
    // Новый пакет пишется заново целиком — оба файла, прежний «A.pdf» не перезаписан.
    const again = unwrap(await writer.write(folder, SEPARATE));
    expect(again.written.map((file) => file.fileName)).toEqual(['A (2).pdf', 'B.pdf']);
    expect((await readdir(folder)).sort()).toEqual(['A (2).pdf', 'A.pdf', 'B.pdf']);
  });

  it('повтор при том же снимке и журнале дописывает только неудавшийся файл', async () => {
    const { folder, writer, setFailSecond } = await setup();
    setFailSecond(true);
    expect(unwrap(await writer.write(folder, SEPARATE)).failed).toHaveLength(1);
    setFailSecond(false);

    const retried = unwrap(await writer.write(folder, { ...SEPARATE, retry: true }));

    expect(retried.failed).toEqual([]);
    expect(retried.written.map((file) => file.fileName)).toEqual(['A.pdf', 'B.pdf']);
  });
});
