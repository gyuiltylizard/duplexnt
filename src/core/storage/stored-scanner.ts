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
