import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { Snapshot } from '../../src/shared';
import { probeScanner } from '../../src/core/escl/connect';
import type { ScanJobLimits } from '../../src/core/escl/scan-job';
import {
  openPassService,
  type PassService,
  type PassServiceOptions,
} from '../../src/core/scan/pass-service';
import { storedScannerOf, type StoredScanner } from '../../src/core/storage/stored-scanner';
import type { Scenario } from '../emulator/scenarios';
import { startTestEmulator } from './emulator';
import { levelWorker } from './image-worker';
import { unwrap } from './result';
import { makeTempDataRoot } from './temp-data-root';
import { untilScored } from './until';
import { noSearch } from './uuid-search';

// Общая обвязка тестов службы проходов на эмуляторе (M4.5, U8): эмулятор, служба на временном
// корне, перезапуск, вступительные проходы, запись одним файлом. Вызывать изнутри `it(...)`.

/**
 * Правила задания как в продукте, но время сжато. Ожидание страницы (`pageIdleTimeoutMs`,
 * `pageDeadlineMs`) — с запасом: эмулятор в том же процессе под нагрузкой (параллельные файлы,
 * рядом работающее приложение) отдаёт заголовки страницы дольше 300 мс, и проход обрывался сам
 * «простоем» (журналы 0008, 0027). Сбои подачи в тестах — `gone` / `stall`; `stall` ждёт этот
 * срок. Тесты самих сроков транспорта держат свои лимиты (`scan-job.emulator`).
 */
export const FAST_JOB_LIMITS: Partial<ScanJobLimits> = {
  retryDelayMs: 5,
  busyCeilingMs: 200,
  notReadyCeilingMs: 2000,
  pageIdleTimeoutMs: 1500,
  pageDeadlineMs: 5000,
  deleteDeadlineMs: 300,
};

/**
 * Эмулятор по сценарию и служба на временном корне с подключённым сканером. `snapshots` копит
 * снимки всех запусков службы (экраны выводятся из `pass.kind`); `restart` — та же служба заново
 * на том же корне и сканере (прецедент `blank-backs`), по умолчанию с теми же опциями.
 */
export async function connectService(
  scenario: Partial<Scenario>,
  base: PassServiceOptions,
  extra: Partial<PassServiceOptions> = {},
  /** Посев корня до открытия службы (M6, U9): журнал прежней версии, страницы на диске. */
  prepare?: (root: string, scanner: StoredScanner) => Promise<void>,
) {
  const emulator = await startTestEmulator({ scenario });
  const connected = unwrap(await probeScanner({ ...emulator, fingerprint: null }));
  const root = await makeTempDataRoot();
  await prepare?.(root, storedScannerOf(connected));
  const snapshots: Snapshot[] = [];
  const open = async (options: Partial<PassServiceOptions> = extra): Promise<PassService> => {
    let opened: PassService | null = null;
    // Проверка запомненного не открывает сокеты 5353: поиск по UUID — пустой (M5, KTD9).
    opened = await openPassService(root, {
      findByUuid: noSearch,
      // Измерение перекоса — заглушка «ровно»: настоящее стоит ~200 мс на страницу (M6, U5).
      imageWorker: levelWorker,
      ...base,
      ...options,
      onChange: () => {
        if (opened !== null) {
          snapshots.push(opened.snapshot());
        }
      },
    });
    await opened.useScanner(connected);
    return opened;
  };
  const service = await open();
  return { emulator, root, service, snapshots, restart: open };
}

/** Проходы без намерения по порядку: каждый завершён с ожидаемым числом страниц. */
export async function scanned(service: PassService, ...pages: readonly number[]): Promise<void> {
  for (const count of pages) {
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: count });
  }
}

/** Запись одним файлом после прихода оценок; путь к PDF — фактический (повтор даёт « (2)»). */
export async function saveSingle(
  service: PassService,
  root: string,
  name = 'Документ',
): Promise<string> {
  const folder = join(root, 'выход');
  await mkdir(folder, { recursive: true });
  await untilScored(() => service.snapshot());
  const saved = unwrap(
    await service.saveDocuments(folder, { mode: 'single', names: [name], retry: false }),
  );
  expect(saved.failed).toEqual([]);
  expect(saved.written).toHaveLength(1);
  return join(folder, saved.written[0]?.fileName ?? '');
}
