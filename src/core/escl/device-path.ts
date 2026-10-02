// Пути устройства — один проверяющий модуль (план M1, KTD-7; ADR 0006). Базовый путь из ручного
// ввода, `rs` из mDNS, `Location` из ответа на создание задания и `JobUri` из статуса — данные,
// а не адреса: из них берётся только путь, и только после проверки. Схема, хост и порт из
// заголовка отбрасываются — запрос всегда уходит на origin профиля.

export const DEVICE_PATH_MAX_LENGTH = 512;

/** Коллекция заданий под базовым путём. */
export const SCAN_JOBS_SEGMENT = 'ScanJobs';

// Сегмент пути — только незарезервированные символы URI. Этим же отсекаются процент-кодирование
// (`%2f`, `%2e%2e`), обратный слэш, пробелы и управляющие символы.
const SEGMENT = /^[A-Za-z0-9._~-]+$/;

const isDotSegment = (segment: string): boolean => segment === '.' || segment === '..';

// Печатные символы ASCII без пробела и обратного слэша.
function isPlainAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code >= 0x7f || code === 0x5c) {
      return false;
    }
  }
  return true;
}

function cleanSegments(path: string): string[] | null {
  const segments = path.split('/');
  // Путь начинается со слэша: первый элемент — пустой, остальные — сегменты.
  if (segments.shift() !== '') {
    return null;
  }
  return segments.every((it) => SEGMENT.test(it) && !isDotSegment(it)) ? segments : null;
}

/**
 * Базовый путь eSCL: `/eSCL`, без завершающего слэша; корень — пустая строка. Принимает и
 * `eSCL` без ведущего слэша — так его объявляет запись `rs` в mDNS. Всё, что не является простым
 * путём, — `null`.
 */
export function normalizeBasePath(input: string): string | null {
  if (input.length > DEVICE_PATH_MAX_LENGTH) {
    return null;
  }
  const trimmed = input.trim().replace(/\/+$/, '');
  if (trimmed === '') {
    return '';
  }
  const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return cleanSegments(path) === null ? null : path;
}

/** Путь лежит строго под базой — по границе сегмента: `/eSCLx/…` под `/eSCL` не лежит. */
export function isUnderBase(path: string, basePath: string): boolean {
  if (path.length > DEVICE_PATH_MAX_LENGTH || cleanSegments(path) === null) {
    return false;
  }
  return path.startsWith(`${basePath}/`) && path.length > basePath.length + 1;
}

/**
 * Путь задания из `Location` или `JobUri`. Значение перебазируется на origin профиля: схема,
 * хост и порт отбрасываются. Результат обязан лежать строго под `<база>/ScanJobs/`; запрос,
 * фрагмент, точечные сегменты, кодирование и сама коллекция — отказ.
 */
export function jobPathFromLocation(
  location: string | null | undefined,
  basePath: string,
): string | null {
  if (location === null || location === undefined || location === '') {
    return null;
  }
  if (location.length > DEVICE_PATH_MAX_LENGTH) {
    return null;
  }
  // Эти проверки идут по сырому значению: разборщик URL молча схлопывает точечные сегменты,
  // превращает обратный слэш в прямой и выбрасывает табуляцию с переводами строк.
  if (location.split('/').some(isDotSegment) || !isPlainAscii(location)) {
    return null;
  }

  const collection = `${basePath}/${SCAN_JOBS_SEGMENT}`;
  let url: URL;
  try {
    // Относительное значение разрешается от адреса запроса, создавшего задание.
    url = new URL(location, `http://device.invalid${collection}`);
  } catch {
    return null;
  }
  if (url.search !== '' || url.hash !== '' || location.includes('?') || location.includes('#')) {
    return null;
  }

  const path = url.pathname;
  if (!path.startsWith(`${collection}/`) || !isUnderBase(path, collection)) {
    return null;
  }
  return path;
}
