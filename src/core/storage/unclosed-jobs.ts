import { z } from 'zod';
import { ok, type Result } from '@shared';
import { DEVICE_PATH_MAX_LENGTH } from '../escl/device-path';
import { layoutOf } from './layout';
import { realStorageFs, storageFailure, type StorageOptions } from './storage-fs';
import { sameScanner, storedScannerSchema, type StoredScanner } from './stored-scanner';
import { readVersioned, setAside, writeVersioned } from './versioned-file';

// Незакрытые задания сканера (план M1, KTD-11; ADR 0004, амендмент). Адрес задания записывается
// сразу после ответа `201` и убирается, когда задание закрыто. Файл лежит в корне данных, а не
// в сессии: «Остановить» и «Новая пачка» удаляют сессию, а задание на устройстве остаётся и
// держит его занятым до пяти минут (журнал M1, U1).
//
// Вместе с адресом записан сканер: перед следующим `POST` закрываются только задания того же
// устройства, чужому `DELETE` не уходит. Путь перед запросом заново проходит проверку KTD-7 —
// здесь он только строка ограниченной длины.

export const UNCLOSED_JOBS_VERSION = 1;

/** Больше заданий копить незачем: устройство само снимает брошенное задание через пять минут. */
const MAX_JOBS = 16;

const unclosedJobSchema = z.strictObject({
  scanner: storedScannerSchema,
  jobPath: z.string().min(1).max(DEVICE_PATH_MAX_LENGTH),
});

const unclosedJobsSchema = z.strictObject({
  version: z.literal(UNCLOSED_JOBS_VERSION),
  jobs: z.array(unclosedJobSchema).max(MAX_JOBS),
});

export type UnclosedJob = z.infer<typeof unclosedJobSchema>;

export interface UnclosedJobs {
  /** Адреса незакрытых заданий этого сканера. */
  jobsOf(scanner: StoredScanner): readonly string[];
  /** Записывает адрес задания. Отказ записи адрес не теряет: он остаётся в памяти. */
  add(scanner: StoredScanner, jobPath: string): Promise<Result<void>>;
  /** Задание закрыто — или устройство ответило, что его уже нет. */
  remove(scanner: StoredScanner, jobPath: string): Promise<Result<void>>;
}

export async function openUnclosedJobs(
  dataRoot: string,
  options: StorageOptions = {},
): Promise<UnclosedJobs> {
  const { root, unclosedJobsFile } = layoutOf(dataRoot);
  const fs = options.fs ?? realStorageFs;
  const io = options.retry === undefined ? { fs } : { fs, retry: options.retry };

  let jobs: readonly UnclosedJob[] = [];
  // Файл более новой версии не переписывается: список живёт только в памяти.
  let frozen = false;
  try {
    const read = await readVersioned(
      fs,
      unclosedJobsFile,
      unclosedJobsSchema,
      UNCLOSED_JOBS_VERSION,
    );
    if (read.kind === 'ok') {
      ({ jobs } = read.value);
    } else if (read.kind === 'incompatible') {
      frozen = true;
    } else if (read.kind === 'unreadable') {
      await setAside(unclosedJobsFile, io);
    }
  } catch {
    // Список — подсказка, а не данные пользователя: без него задание снимет само устройство.
  }

  let tail: Promise<unknown> = Promise.resolve();
  function update(change: (current: readonly UnclosedJob[]) => readonly UnclosedJob[]) {
    const run = tail.then(async (): Promise<Result<void>> => {
      jobs = change(jobs);
      if (frozen) {
        return ok(undefined);
      }
      try {
        await fs.mkdir(root);
        await writeVersioned(unclosedJobsFile, { version: UNCLOSED_JOBS_VERSION, jobs }, io);
        return ok(undefined);
      } catch (error) {
        return { ok: false, error: storageFailure(error) };
      }
    });
    tail = run;
    return run;
  }

  const isJob = (job: UnclosedJob, scanner: StoredScanner, jobPath: string): boolean =>
    job.jobPath === jobPath && sameScanner(job.scanner, scanner);

  return {
    jobsOf: (scanner) =>
      jobs.filter((job) => sameScanner(job.scanner, scanner)).map((job) => job.jobPath),
    add: (scanner, jobPath) =>
      update((current) =>
        [...current.filter((job) => !isJob(job, scanner, jobPath)), { scanner, jobPath }].slice(
          -MAX_JOBS,
        ),
      ),
    remove: (scanner, jobPath) =>
      update((current) => current.filter((job) => !isJob(job, scanner, jobPath))),
  };
}
