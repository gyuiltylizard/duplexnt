import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it } from 'vitest';
import type { PassReport, StartPassRequest } from '@shared';
import { probeScanner, type ConnectedScanner } from '../../src/core/escl/connect';
import type { PassService } from '../../src/core/scan/pass-service';
import { unwrap } from './result';

// Прогон против живого устройства — только по явному согласию (план M1, KTD-30): адрес сканера
// приходит переменной окружения и в репозиторий не записывается. Без неё тесты пропускаются с
// предупреждением, и `test:all` остаётся зелёным без сети и сканера.

export const LIVE_DEVICE_ENV = 'DUPLEXNT_SCANNER_HOST';

interface SuiteApi {
  (name: string, body: () => void): unknown;
  skip(name: string, body: () => void): unknown;
}

interface LiveOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly warn?: (message: string) => void;
  readonly suite?: SuiteApi;
}

/** Адрес живого сканера или `null`. Само значение в вывод не попадает. */
export function liveDeviceHost(env: LiveOptions['env'] = process.env): string | null {
  const host = env[LIVE_DEVICE_ENV]?.trim() ?? '';
  return host === '' ? null : host;
}

/** Пробник живого сканера по адресу из переменной: HTTPS, стандартный порт и путь eSCL. */
export async function probeLive(host: string): Promise<ConnectedScanner> {
  const probed = await probeScanner({
    scheme: 'https',
    host,
    port: 443,
    basePath: '/eSCL',
    fingerprint: null,
  });
  if (!probed.ok) {
    throw new Error(`сканер не подключился: ${probed.error.code}`);
  }
  return probed.value;
}

/** Сколько ждать бумаги в лотке между проходами по умолчанию: попытки идут, пока лоток пуст. */
export const PAPER_DEADLINE_MS = 5 * 60_000;
const PAPER_RETRY_DELAY_MS = 5_000;

/**
 * Проход стартует, как только в лотке появится бумага: пока устройство отвечает «нет бумаги»,
 * попытки повторяются до срока. Иной отказ — ошибка.
 */
export async function startPassWhenPaper(
  service: PassService,
  request: StartPassRequest,
  deadlineMs = PAPER_DEADLINE_MS,
): Promise<PassReport> {
  const deadline = Date.now() + deadlineMs;
  let result = await service.startPass(request);
  while (!result.ok && result.error.code === 'scanNoPaper' && Date.now() < deadline) {
    await sleep(PAPER_RETRY_DELAY_MS);
    result = await service.startPass(request);
  }
  return unwrap(result);
}

/**
 * Набор тестов против живого устройства. Тело получает адрес и вызывается, только когда он задан.
 * Вывод тестов не должен нести адрес: он идентифицирует сеть автора.
 */
export function describeLive(
  name: string,
  body: (host: string) => void,
  options: LiveOptions = {},
): void {
  const suite = options.suite ?? describe;
  const warn =
    options.warn ??
    ((message: string) => {
      console.warn(message);
    });
  const host = liveDeviceHost(options.env);

  if (host === null) {
    warn(`[live] «${name}» пропущен: переменная ${LIVE_DEVICE_ENV} не задана`);
    suite.skip(name, () => {
      it(`нужен живой сканер: ${LIVE_DEVICE_ENV}`, () => undefined);
    });
    return;
  }
  suite(name, () => {
    body(host);
  });
}
