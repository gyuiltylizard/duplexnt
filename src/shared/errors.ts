// Доменные ошибки моста (ADR 0005). Команда возвращает результат-конверт: успех со значением или
// отказ с кодом. Текст для пользователя живёт в локали интерфейса и выбирается по коду — ядро
// отдаёт данные, не текст. Отказ `invoke` остаётся только для ошибок программы: нарушение
// контракта, чужой отправитель, баг.
//
// Каждый новый код — строка здесь и строка в `errors.<код>` локали.

export const ERROR_CODES = [
  'invalidInput',
  // Ответ устройства не разобран: не XML, не UTF-8, с DOCTYPE, больше потолка. Причина — в деталях.
  'scannerBadResponse',
  'notEsclScanner',
  'scannerNoAdf',
  'scannerNoJpeg',
  // Параметр сканирования, которого нет у устройства; какой именно — в деталях (`field`).
  'scanParamsUnsupported',
  // Соединение со сканером не состоялось или оборвалось; причина — в деталях (`reason`).
  'scannerUnreachable',
  // По адресу сканера отвечает устройство с другим сертификатом (план M1, KTD-40).
  'scannerCertificateChanged',
  // Устройство занято дольше потолка ожидания: `POST /ScanJobs` отвечает `503`.
  'scannerBusy',
  // Устройство ответило `409` на параметры задания: заявило их в capabilities, но не берёт.
  'scanParamsRejected',
  // Устройство оборвало задание: сбой подачи (`410`) или страница так и не стала готова.
  'scanFeedFailed',
  // Операция отменена самим приложением: «Остановить», закрытие окна, новое подключение.
  'canceled',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Детали — для диагностики и подстановок в текст; только то, что переживает structured clone. */
export type ErrorDetails = Readonly<Record<string, string | number | boolean | null>>;

export interface DomainError {
  readonly code: ErrorCode;
  readonly details?: ErrorDetails;
}

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: DomainError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail(code: ErrorCode, details?: ErrorDetails): Result<never> {
  return { ok: false, error: details === undefined ? { code } : { code, details } };
}
