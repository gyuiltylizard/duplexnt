import { normalizeBasePath } from '../escl/device-path';
import { displayText } from '../escl/xml';

// Объявления mDNS — в записи о сканерах (план M1, U12, KTD-12). Чистые функции: сеть и библиотека
// остаются в ./mdns.ts. Объявление — недоверенный вход из локальной сети: его может прислать
// любое устройство, поэтому строки идут только на показ, с потолком длины и без управляющих
// символов, а путь — через общую проверку путей устройства.

/** Сервисы eSCL: `_uscan._tcp` и `_uscans._tcp`. Схему тип сервиса не определяет (KTD-8). */
export const SERVICE_TYPES = ['uscan', 'uscans'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

/** Объявление сервиса, как его отдаёт слой библиотеки. */
export interface Announcement {
  /** Имя экземпляра сервиса. */
  readonly name: string;
  readonly port: number;
  /** Адреса из записей A и AAAA. */
  readonly addresses: readonly string[];
  /** Сырые записи TXT: `ключ=значение`. */
  readonly txt: readonly Uint8Array[];
}

/** Сканер по объявлению. */
export interface ScannerRecord {
  /** UUID устройства в нижнем регистре; `null` — не объявлен. Защитой не служит (KTD-40). */
  readonly uuid: string | null;
  readonly name: string | null;
  /** IPv4-адрес из объявления: профиль хранит его, а не имя, которое разрешается заново. */
  readonly address: string;
  readonly port: number;
  readonly basePath: string;
  readonly hasAdf: boolean;
}

const DEFAULT_RESOURCE_PATH = 'eSCL';

const TXT_MAX_ENTRIES = 64;
const TXT_KEY_MAX_LENGTH = 64;
const TXT_KEY = /^[\x21-\x3c\x3e-\x7e]+$/;

/**
 * Записи TXT в таблицу. Ключи сравниваются без учёта регистра: ET-3850 отдаёт `UUID` и `usb_MFG`
 * прописными, остальное строчными. Запись без значения (`note=`) и запись-флаг без знака равенства
 * дают пустую строку. Повтор ключа не перезаписывает первое значение.
 */
export function parseTxt(entries: readonly Uint8Array[]): Map<string, string> {
  const table = new Map<string, string>();
  const decoder = new TextDecoder('utf-8');
  for (const entry of entries.slice(0, TXT_MAX_ENTRIES)) {
    const text = decoder.decode(entry);
    const separator = text.indexOf('=');
    const key = (separator === -1 ? text : text.slice(0, separator)).toLowerCase();
    if (key.length > TXT_KEY_MAX_LENGTH || !TXT_KEY.test(key) || table.has(key)) {
      continue;
    }
    table.set(key, separator === -1 ? '' : text.slice(separator + 1));
  }
  return table;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Адрес, по которому можно подключиться: четыре октета, не «любой», не групповой и не
// зарезервированный. Адреса IPv6 из объявления в M1 не используются (KTD-12).
function isUnicastIpv4(address: string): boolean {
  const octets = address.split('.');
  if (octets.length !== 4 || !octets.every((it) => /^\d{1,3}$/.test(it) && Number(it) <= 255)) {
    return false;
  }
  const first = Number(octets[0]);
  return first >= 1 && first < 224;
}

/** Запись о сканере из объявления; `null` — подключиться по нему нельзя. */
export function recordOf(announcement: Announcement): ScannerRecord | null {
  const address = announcement.addresses.find(isUnicastIpv4);
  const { port } = announcement;
  if (address === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  const txt = parseTxt(announcement.txt);
  const uuid = txt.get('uuid')?.toLowerCase() ?? '';
  // Источники перечислены через запятую: `platen,adf`.
  const sources = (txt.get('is') ?? '').split(',').map((it) => it.trim().toLowerCase());
  // `rs` с запросом, точечным сегментом или кодированием базовым путём не становится.
  const resourcePath = txt.get('rs') ?? '';
  const basePath =
    normalizeBasePath(resourcePath === '' ? DEFAULT_RESOURCE_PATH : resourcePath) ??
    normalizeBasePath(DEFAULT_RESOURCE_PATH) ??
    '';

  return {
    uuid: UUID.test(uuid) ? uuid : null,
    name: displayText(txt.get('ty') ?? null) ?? displayText(announcement.name),
    address,
    port,
    basePath,
    hasAdf: sources.includes('adf'),
  };
}

/**
 * Одно ли это устройство (KTD-12): совпадают адрес с портом и UUID. Объявление без UUID
 * схлопывается по адресу и порту; один UUID с двух адресов — две записи.
 */
export function sameScanner(a: ScannerRecord, b: ScannerRecord): boolean {
  return (
    a.address === b.address &&
    a.port === b.port &&
    (a.uuid === null || b.uuid === null || a.uuid === b.uuid)
  );
}

/**
 * Добавляет запись в список. Повторное объявление — от второго сервиса или со второго интерфейса
 * — сливается с имеющейся записью на её месте: позиция записи в списке не меняется. Список не
 * растёт сверх потолка. Возвращает тот же массив, если ничего не изменилось.
 */
export function mergeRecord(
  records: readonly ScannerRecord[],
  incoming: ScannerRecord,
  maxRecords: number,
): readonly ScannerRecord[] {
  const index = records.findIndex((it) => sameScanner(it, incoming));
  if (index === -1) {
    return records.length >= maxRecords ? records : [...records, incoming];
  }
  const existing = records[index];
  if (existing === undefined) {
    return records;
  }
  const merged: ScannerRecord = {
    ...existing,
    uuid: existing.uuid ?? incoming.uuid,
    name: existing.name ?? incoming.name,
    // Автоподача объявлена хотя бы одним из сервисов.
    hasAdf: existing.hasAdf || incoming.hasAdf,
  };
  if (
    merged.uuid === existing.uuid &&
    merged.name === existing.name &&
    merged.hasAdf === existing.hasAdf
  ) {
    return records;
  }
  return records.with(index, merged);
}
