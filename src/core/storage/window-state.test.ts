import { readdir, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { fsError, interceptFs } from '../../../test/support/intercept-fs';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import { layoutOf } from './layout';
import { realStorageFs } from './storage-fs';
import { openWindowStateStore, type WindowState } from './window-state';

const STATE: WindowState = {
  bounds: { x: 120, y: 80, width: 1400, height: 900 },
  maximized: false,
};

describe('состояние окна (B-3)', () => {
  it('файла нет — состояния нет, каталог данных не тронут', async () => {
    const root = await makeTempDataRoot();

    const store = await openWindowStateStore(root);

    expect(store.get()).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  it('записанное переживает повторное открытие', async () => {
    const root = await makeTempDataRoot();
    const store = await openWindowStateStore(root);

    expect(await store.save({ ...STATE, maximized: true })).toMatchObject({ ok: true });

    expect((await openWindowStateStore(root)).get()).toEqual({ ...STATE, maximized: true });
    expect(JSON.parse(await readFile(layoutOf(root).windowFile, 'utf8'))).toEqual({
      version: 1,
      ...STATE,
      maximized: true,
    });
  });

  it('негодное значение не пишется ни в файл, ни в память', async () => {
    const root = await makeTempDataRoot();
    const store = await openWindowStateStore(root);
    await store.save(STATE);

    const broken = { ...STATE, bounds: { ...STATE.bounds, width: 0 } };
    expect(await store.save(broken)).toMatchObject({
      ok: false,
      error: { code: 'storageFailed', details: { reason: 'schema' } },
    });

    expect(store.get()).toEqual(STATE);
    expect((await openWindowStateStore(root)).get()).toEqual(STATE);
  });

  it('нечитаемый файл отодвигается, а не удаляется; окно — по умолчанию', async () => {
    const root = await makeTempDataRoot();
    await writeFile(layoutOf(root).windowFile, '{ оборвано');

    const store = await openWindowStateStore(root);

    expect(store.get()).toBeNull();
    const names = await readdir(root);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^window\.json\.unreadable-[0-9a-f]{12}$/);
  });

  it('файл более новой версии не переписывается: состояние живёт в памяти', async () => {
    const root = await makeTempDataRoot();
    const file = layoutOf(root).windowFile;
    const newer = JSON.stringify({ version: 2, monitors: 'что-то новое' });
    await writeFile(file, newer);

    const store = await openWindowStateStore(root);
    expect(store.get()).toBeNull();
    expect(await store.save(STATE)).toMatchObject({ ok: true });

    expect(store.get()).toEqual(STATE);
    expect(await readFile(file, 'utf8')).toBe(newer);
  });

  it('файл не прочитался — он не переписывается: что в нём, неизвестно', async () => {
    const root = await makeTempDataRoot();
    const file = layoutOf(root).windowFile;
    const before = JSON.stringify({ version: 1, ...STATE });
    await writeFile(file, before);
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (call.op === 'readFile') {
        throw fsError('EBUSY');
      }
    });

    const store = await openWindowStateStore(root, { fs, retry: { ceilingMs: 0 } });
    expect(store.get()).toBeNull();
    expect(await store.save({ ...STATE, maximized: true })).toMatchObject({ ok: true });

    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('отказ записи — ошибкой, состояние в памяти остаётся', async () => {
    const root = await makeTempDataRoot();
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (call.op === 'rename') {
        throw fsError('EACCES');
      }
    });
    const store = await openWindowStateStore(root, { fs, retry: { ceilingMs: 0 } });

    expect(await store.save(STATE)).toMatchObject({
      ok: false,
      error: { code: 'storageFailed' },
    });
    expect(store.get()).toEqual(STATE);
  });
});
