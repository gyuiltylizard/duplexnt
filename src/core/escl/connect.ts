import { fail, ok, type Result } from '@shared';
import { parseCapabilities, type ScannerCapabilities } from './capabilities';
import { DEFAULT_BASE_PATH, normalizeBasePath } from './device-path';
import { scanOptionsOf, type ScanOptions } from './scan-settings';
import {
  createTransport,
  type ScannerProfile,
  type ScannerTransport,
  type TransportLimits,
  type UnreachableReason,
} from './transport';
import type { BadResponseReason } from './xml';

// Подключение по адресу (план M1, U11, KTD-8, KTD-39): введённый адрес превращается в проверенный
// профиль сканера. Профиль создаётся только после того, как устройство отдало capabilities и они
// годятся: есть автоподача, JPEG и хотя бы один вариант каждого параметра.

const DEFAULT_PORT = { https: 443, http: 80 } as const;

const ADDRESS_MAX_LENGTH = 1024;
const HOST_MAX_LENGTH = 253;

export type Scheme = ScannerProfile['scheme'];

/** Адрес сканера после разбора ввода. */
export interface ScannerAddress {
  /** `null` — схема не названа: сначала HTTPS, при отказе соединения — HTTP (KTD-8). */
  readonly scheme: Scheme | null;
  /** Имя или IPv4-адрес, в нижнем регистре. */
  readonly host: string;
  /** `null` — порт не назван: по умолчанию для схемы. */
  readonly port: number | null;
  /** Нормализованный базовый путь. */
  readonly basePath: string;
}

export interface ConnectedScanner {
  /** Профиль с выбранной схемой и отпечатком сертификата из первого ответа; на HTTP — `null`. */
  readonly profile: ScannerProfile;
  readonly capabilities: ScannerCapabilities;
  /** Варианты параметров для интерфейса. */
  readonly options: ScanOptions;
}

// Схема — только из перечисления; хост — без userinfo; запрос и фрагмент не допускаются вовсе.
const ADDRESS = /^(?:(https?):\/\/)?([^/?#\\\s]*)(\/[^?#]*)?$/i;
const AUTHORITY = /^([^:@[\]]+)(?::(\d{1,5}))?$/;
// Имя хоста: метки из букв, цифр, дефиса и подчёркивания; IPv4-адрес под это правило подходит.
// Литерал IPv6 не принимается: адреса IPv6 в M1 не используются (KTD-12).
const HOST_LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;

function isHostName(host: string): boolean {
  if (host.length > HOST_MAX_LENGTH) {
    return false;
  }
  const labels = (host.endsWith('.') ? host.slice(0, -1) : host).split('.');
  return labels.every((label) => HOST_LABEL.test(label));
}

/**
 * Разбор ручного ввода: хост, хост с портом или полный URL. Пустой путь — `/eSCL`. Всё, что не
 * разобрано, — `invalidInput` без обращения к сети.
 */
export function parseScannerAddress(input: string): Result<ScannerAddress> {
  const invalid = (field: string): Result<never> => fail('invalidInput', { field });

  const text = input.trim();
  if (text === '' || text.length > ADDRESS_MAX_LENGTH) {
    return invalid('address');
  }
  const match = ADDRESS.exec(text);
  if (match === null) {
    return invalid('address');
  }
  const [, rawScheme, rawAuthority = '', rawPath = ''] = match;

  const authority = AUTHORITY.exec(rawAuthority);
  const host = authority?.[1]?.toLowerCase() ?? '';
  if (authority === null || !isHostName(host)) {
    return invalid('host');
  }
  const port = authority[2] === undefined ? null : Number(authority[2]);
  if (port !== null && (port < 1 || port > 65535)) {
    return invalid('port');
  }

  // Пустой путь и одиночный слэш — «путь не назван».
  const basePath = /^\/*$/.test(rawPath) ? DEFAULT_BASE_PATH : normalizeBasePath(rawPath);
  if (basePath === null) {
    return invalid('path');
  }

  return ok({
    scheme: rawScheme === undefined ? null : (rawScheme.toLowerCase() as Scheme),
    host,
    port,
    basePath,
  });
}

export interface ConnectorOptions {
  /** Подмена транспорта — для тестов. */
  readonly createTransport?: (
    profile: ScannerProfile,
    limits?: Partial<TransportLimits>,
  ) => ScannerTransport;
  readonly limits?: Partial<TransportLimits>;
}

export interface Connector {
  /** Новое подключение отменяет идущее: прежний вызов возвращает `canceled`. */
  connect(address: ScannerAddress): Promise<Result<ConnectedScanner>>;
  /** Отменяет идущее подключение. */
  cancel(): void;
}

// Ответ `200`, который не разобрался как XML, — это чужая страница (веб-интерфейс роутера), а не
// испорченный ответ сканера.
const NOT_XML_REASONS: ReadonlySet<unknown> = new Set<BadResponseReason>([
  'malformed',
  'doctype',
  'notUtf8',
]);

// Переход на HTTP — только при отказе соединения и сбое рукопожатия. Таймаут сюда не входит:
// молчащий адрес по HTTP тоже промолчит, а пользователь прождёт вдвое дольше (KTD-8).
const FALLBACK_REASONS: ReadonlySet<unknown> = new Set<UnreachableReason>(['refused', 'tls']);

/**
 * Проба профиля: capabilities запрашиваются временным транспортом с теми же инвариантами, что у
 * рабочего, и он уничтожается при любом исходе (KTD-39): рабочий транспорт создаёт под профиль
 * служба прохода. Схема не меняется: её выбирает подключение, а не проба.
 *
 * Профиль без отпечатка — первое подключение: отпечаток берётся из ответа. Профиль с отпечатком —
 * запомненный сканер: другой сертификат на адресе транспорт отклоняет сам (KTD-40).
 */
export async function probeScanner(
  profile: ScannerProfile,
  options: ConnectorOptions = {},
  signal?: AbortSignal,
): Promise<Result<ConnectedScanner>> {
  const transport = (options.createTransport ?? createTransport)(profile, options.limits);
  try {
    const response = await transport.request({
      method: 'GET',
      path: `${profile.basePath}/ScannerCapabilities`,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      return response;
    }
    if (response.value.status !== 200) {
      return fail('notEsclScanner', { status: response.value.status });
    }

    const capabilities = parseCapabilities(response.value.body);
    if (!capabilities.ok) {
      const { code, details } = capabilities.error;
      return code === 'scannerBadResponse' && NOT_XML_REASONS.has(details?.reason)
        ? fail('notEsclScanner')
        : capabilities;
    }
    const scanOptions = scanOptionsOf(capabilities.value);
    // JPEG заявлен, но ни одного цветового режима, который устройство отдаёт в JPEG, нет.
    if (scanOptions.colorModes.length === 0) {
      return fail('scannerNoJpeg');
    }
    if (scanOptions.paperSizes.length === 0) {
      return fail('scanParamsUnsupported', { field: 'paperSize' });
    }
    return ok({
      // Отпечаток — из ответа (KTD-40); дальше его сверяет транспорт профиля.
      profile: { ...profile, fingerprint: response.value.fingerprint },
      capabilities: capabilities.value,
      options: scanOptions,
    });
  } finally {
    transport.close();
  }
}

export function createConnector(options: ConnectorOptions = {}): Connector {
  let current: AbortController | null = null;

  // Подключение — явное действие пользователя: проба идёт без запомненного отпечатка.
  const probe = (
    address: ScannerAddress,
    scheme: Scheme,
    signal: AbortSignal,
  ): Promise<Result<ConnectedScanner>> =>
    probeScanner(
      {
        scheme,
        host: address.host,
        port: address.port ?? DEFAULT_PORT[scheme],
        basePath: address.basePath,
        fingerprint: null,
      },
      options,
      signal,
    );

  async function attempt(
    address: ScannerAddress,
    signal: AbortSignal,
  ): Promise<Result<ConnectedScanner>> {
    const first = await probe(address, address.scheme ?? 'https', signal);
    // Явная схема не меняется никогда.
    if (first.ok || address.scheme !== null) {
      return first;
    }
    const { code, details } = first.error;
    if (code !== 'scannerUnreachable' || !FALLBACK_REASONS.has(details?.reason)) {
      return first;
    }
    // Порт, названный пользователем, сохраняется; не названный — по умолчанию для HTTP.
    return probe(address, 'http', signal);
  }

  return {
    async connect(address) {
      current?.abort();
      const controller = new AbortController();
      current = controller;

      const result = await attempt(address, controller.signal);
      // Позднее завершение отменённого подключения профиль не создаёт.
      if (controller.signal.aborted) {
        return fail('canceled');
      }
      current = null;
      return result;
    },
    cancel() {
      current?.abort();
      current = null;
    },
  };
}
