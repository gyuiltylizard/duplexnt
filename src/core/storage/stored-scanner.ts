import { z } from 'zod';
import type { ScannerInfo } from '@shared';
import type { ConnectedScanner } from '../escl/connect';
import { normalizeBasePath } from '../escl/device-path';
import type { ScannerProfile } from '../escl/transport';
import { displayText } from '../escl/xml';
import { PORT_MAX } from '@shared';

// Сканер, как он записан на диск: в настройках (запомненный), в журнале (сканер прохода) и в
// файле незакрытых заданий. Одна форма на все три места — и одно правило «то же ли это устройство».

export const storedScannerSchema = z.strictObject({
  scheme: z.enum(['https', 'http']),
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(PORT_MAX),
  basePath: z
    .string()
    .max(512)
    .refine((path) => normalizeBasePath(path) === path),
  /** SHA-256 сертификата (KTD-40); у профиля на HTTP отпечатка нет. */
  fingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  /** UUID из capabilities. Защитой не является: объявляется в сеть открыто. */
  uuid: z.string().min(1).max(128).nullable(),
  /** Название для показа — `MakeAndModel` устройства. */
  name: z.string().max(256).nullable(),
});

export type StoredScanner = z.infer<typeof storedScannerSchema>;

export function storedScannerOf({ profile, capabilities }: ConnectedScanner): StoredScanner {
  // Поля перечислены явно: схема строгая, и лишнее поле профиля сделало бы файл несовместимым.
  const { scheme, host, port, basePath, fingerprint } = profile;
  return {
    scheme,
    host,
    port,
    basePath,
    fingerprint,
    uuid: capabilities.uuid,
    name: capabilities.makeAndModel,
  };
}

/**
 * Сканер, как его показывает интерфейс: имя и адрес, без отпечатка и UUID. Имя проходит
 * чистку показа и здесь: записанное на диск прежней версией могло её не проходить.
 */
export function scannerInfoOf({ name, scheme, host, port }: StoredScanner): ScannerInfo {
  return { name: displayText(name), scheme, host, port };
}

export function profileOf(scanner: StoredScanner): ScannerProfile {
  const { scheme, host, port, basePath, fingerprint } = scanner;
  return { scheme, host, port, basePath, fingerprint };
}

/**
 * То же ли это устройство. Сравнивается всё, что известно у обоих: отпечаток сертификата и UUID;
 * расхождение в любом — другое устройство. Когда сравнить нечем (HTTP без UUID), остаётся адрес.
 */
export function sameScanner(a: StoredScanner, b: StoredScanner): boolean {
  const comparable: [string | null, string | null][] = [
    [a.fingerprint, b.fingerprint],
    [a.uuid, b.uuid],
  ];
  const known = comparable.filter(([left, right]) => left !== null && right !== null);
  if (known.length === 0) {
    return a.host === b.host && a.port === b.port;
  }
  return known.every(([left, right]) => left === right);
}

/**
 * Можно ли досканировать проход, начатый на `passScanner`, на `current` (B-29, KTD-6).
 * `sameScanner` намеренно снисходителен: проход с отпечатком при текущем сканере без отпечатка
 * (откат на HTTP) сравнил бы только UUID и сказал бы «то же», хотя доказательства уже нет.
 * Такая пара отклоняется здесь: привязку снимает только подтверждённая смена.
 */
export function isResumableOn(passScanner: StoredScanner, current: StoredScanner): boolean {
  if (passScanner.fingerprint !== null && current.fingerprint === null) {
    return false;
  }
  return sameScanner(passScanner, current);
}

/**
 * Нужно ли подтверждение пользователя, прежде чем проба заменит запомненный сканер (B-29, KTD-6;
 * таблица решения плана). Значения сравниваются только когда известны обеим сторонам.
 * «Совпал» — хост или UUID запомненного; порт и схема не сравниваются: иначе откат с 443 на 80
 * при вводе хоста без порта обошёл бы подтверждение. UUID — подсказка, не доказательство:
 * устройство объявляет его само; строки с UUID нужны потому, что у HTTP-устройства другого
 * признака нет. Принятые риски: другой хост с другим UUID — выбор пользователя; без запомненного
 * отпечатка — доверие при первой привязке, как и первое подключение.
 */
export function needsDeviceConfirmation(
  remembered: StoredScanner | null,
  probe: StoredScanner,
): boolean {
  if (remembered === null) {
    return false;
  }
  const uuidDiffers =
    remembered.uuid !== null && probe.uuid !== null && remembered.uuid !== probe.uuid;
  // Тот же сертификат — то же устройство, где бы оно ни стояло; насторожить может только другой UUID.
  if (remembered.fingerprint !== null && probe.fingerprint === remembered.fingerprint) {
    return uuidDiffers;
  }
  const matched =
    remembered.host === probe.host || (remembered.uuid !== null && remembered.uuid === probe.uuid);
  if (!matched) {
    return false;
  }
  // Запомнен отпечаток, а похожее устройство отвечает другим сертификатом или вовсе без него.
  if (remembered.fingerprint !== null) {
    return true;
  }
  // Запомнен HTTP-сканер: единственный признак подмены — другой объявленный UUID.
  return uuidDiffers;
}
