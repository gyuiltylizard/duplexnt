// Доменные ошибки моста (ADR 0005). Команда возвращает результат-конверт: успех со значением или
// отказ с кодом. Текст для пользователя живёт в локали интерфейса и выбирается по коду — ядро
// отдаёт данные, не текст. Отказ `invoke` остаётся только для ошибок программы: нарушение
// контракта, чужой отправитель, баг.
//
// Каждый новый код — строка здесь и строка в `errors.<код>` локали.

export const ERROR_CODES = ['invalidInput'] as const;

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
