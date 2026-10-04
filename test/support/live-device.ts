import { describe, it } from 'vitest';

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
