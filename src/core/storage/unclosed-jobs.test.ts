import { readdir, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { fsError, interceptFs } from '../../../test/support/intercept-fs';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import type { PassOrigin } from './journal';
import { layoutOf } from './layout';
import { createSessionStore } from './session-store';
import { realStorageFs } from './storage-fs';
import { sameScanner, type StoredScanner } from './stored-scanner';
import { openUnclosedJobs } from './unclosed-jobs';

const SCANNER_A: StoredScanner = {
  scheme: 'https',
  host: 'scanner-a.test',
  port: 443,
  basePath: '/eSCL',
  fingerprint: 'aa'.repeat(32),
  uuid: '00000000-0000-4000-8000-00000000000a',
  name: 'Scanner A',
};
const SCANNER_B: StoredScanner = {
  ...SCANNER_A,
  host: 'scanner-b.test',
  fingerprint: 'bb'.repeat(32),
  uuid: '00000000-0000-4000-8000-00000000000b',
  name: 'Scanner B',
};
const JOB = '/eSCL/ScanJobs/job-1';

async function* onePage(): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  yield Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
}

describe('незакрытые задания', () => {
  it('адрес задания записан на диск сразу и переживает повторное открытие', async () => {
    const root = await makeTempDataRoot();
    const jobs = await openUnclosedJobs(root);

    expect(await jobs.add(SCANNER_A, JOB)).toEqual({ ok: true, value: undefined });

    expect(JSON.parse(await readFile(layoutOf(root).unclosedJobsFile, 'utf8'))).toEqual({
      version: 1,
      jobs: [{ scanner: SCANNER_A, jobPath: JOB }],
    });
    expect((await openUnclosedJobs(root)).jobsOf(SCANNER_A)).toEqual([JOB]);
  });

  it('незакрытое задание переживает удаление сессии', async () => {
    const root = await makeTempDataRoot();
    const origin: PassOrigin = {
      scanner: SCANNER_A,
      params: { colorMode: 'RGB24', resolution: 300, paperSize: 'A4' },
      pixelLimit: 1000,
    };
    const store = createSessionStore(root);
    const jobs = await openUnclosedJobs(root);
    await store.beginPass(origin);
    await jobs.add(SCANNER_A, JOB);
    await store.acceptPage(onePage());

    expect(await store.discardSegment()).toEqual({ ok: true, value: { sessionClosed: true } });

    expect(await readdir(root)).toEqual(['unclosed-jobs.json']);
    expect((await openUnclosedJobs(root)).jobsOf(SCANNER_A)).toEqual([JOB]);
  });

  it('задания сканера A не отдаются сканеру B', async () => {
    const root = await makeTempDataRoot();
    const jobs = await openUnclosedJobs(root);
    await jobs.add(SCANNER_A, JOB);
    await jobs.add(SCANNER_B, '/eSCL/ScanJobs/job-2');

    expect(jobs.jobsOf(SCANNER_A)).toEqual([JOB]);
    expect(jobs.jobsOf(SCANNER_B)).toEqual(['/eSCL/ScanJobs/job-2']);
    // Тот же сканер на новом адресе остаётся тем же сканером.
    expect(jobs.jobsOf({ ...SCANNER_A, host: 'moved.test' })).toEqual([JOB]);
  });

  it('закрытое задание убирается; повторная запись того же адреса не даёт дубля', async () => {
    const root = await makeTempDataRoot();
    const jobs = await openUnclosedJobs(root);
    await jobs.add(SCANNER_A, JOB);
    await jobs.add(SCANNER_A, JOB);
    expect(jobs.jobsOf(SCANNER_A)).toEqual([JOB]);

    await jobs.remove(SCANNER_A, JOB);

    expect(jobs.jobsOf(SCANNER_A)).toEqual([]);
    expect((await openUnclosedJobs(root)).jobsOf(SCANNER_A)).toEqual([]);
  });

  it('список ограничен: самые старые адреса вытесняются', async () => {
    const root = await makeTempDataRoot();
    const jobs = await openUnclosedJobs(root);
    for (let number = 1; number <= 20; number += 1) {
      await jobs.add(SCANNER_A, `/eSCL/ScanJobs/job-${number}`);
    }

    const kept = (await openUnclosedJobs(root)).jobsOf(SCANNER_A);
    expect(kept).toHaveLength(16);
    expect(kept.at(0)).toBe('/eSCL/ScanJobs/job-5');
    expect(kept.at(-1)).toBe('/eSCL/ScanJobs/job-20');
  });

  it('файл более новой версии не переписывается: список живёт в памяти', async () => {
    const root = await makeTempDataRoot();
    const file = layoutOf(root).unclosedJobsFile;
    const newer = JSON.stringify({ version: 2, jobs: 'что-то новое' });
    await writeFile(file, newer);

    const jobs = await openUnclosedJobs(root);
    expect(await jobs.add(SCANNER_A, JOB)).toMatchObject({ ok: true });

    expect(jobs.jobsOf(SCANNER_A)).toEqual([JOB]);
    expect(await readFile(file, 'utf8')).toBe(newer);
    expect(await readdir(root)).toEqual(['unclosed-jobs.json']);
  });

  it('нечитаемый файл отодвигается, а не удаляется', async () => {
    const root = await makeTempDataRoot();
    await writeFile(layoutOf(root).unclosedJobsFile, '{ оборвано');

    const jobs = await openUnclosedJobs(root);

    expect(jobs.jobsOf(SCANNER_A)).toEqual([]);
    const names = await readdir(root);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^unclosed-jobs\.json\.unreadable-[0-9a-f]{12}$/);
  });

  it('отказ записи возвращается кодом, адрес остаётся в памяти', async () => {
    const root = await makeTempDataRoot();
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (call.op === 'rename') {
        throw fsError('ENOSPC');
      }
    });
    const jobs = await openUnclosedJobs(root, { fs, retry: { ceilingMs: 0 } });

    expect(await jobs.add(SCANNER_A, JOB)).toMatchObject({
      ok: false,
      error: { code: 'storageFull' },
    });
    expect(jobs.jobsOf(SCANNER_A)).toEqual([JOB]);
  });
});

describe('sameScanner', () => {
  const http: StoredScanner = { ...SCANNER_A, scheme: 'http', port: 80, fingerprint: null };

  it('совпали отпечаток и UUID — то же устройство, даже на другом адресе', () => {
    expect(sameScanner(SCANNER_A, { ...SCANNER_A, host: 'other.test', port: 8443 })).toBe(true);
  });

  it('тот же UUID с другим отпечатком — другое устройство', () => {
    expect(sameScanner(SCANNER_A, { ...SCANNER_A, fingerprint: 'cc'.repeat(32) })).toBe(false);
  });

  it('тот же отпечаток с другим UUID — другое устройство', () => {
    expect(sameScanner(SCANNER_A, { ...SCANNER_A, uuid: 'other' })).toBe(false);
  });

  it('отпечатка у одного нет — сравнивается UUID', () => {
    expect(sameScanner(SCANNER_A, http)).toBe(true);
    expect(sameScanner(SCANNER_A, { ...http, uuid: 'other' })).toBe(false);
  });

  it('сравнить нечем — остаётся адрес', () => {
    const bare: StoredScanner = { ...http, uuid: null };
    expect(sameScanner(bare, { ...bare, name: 'другое имя' })).toBe(true);
    expect(sameScanner(bare, { ...bare, host: 'other.test' })).toBe(false);
    expect(sameScanner(bare, { ...bare, port: 8080 })).toBe(false);
  });
});
