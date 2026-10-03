import type { DomainError } from '@shared';
import type { TFunction } from 'i18next';

// Текст доменной ошибки (план M1, U19 → Copy): вариант по `details.reason` / `details.field`,
// базовый ключ `errors.<код>` — без причины. Наборы причин ниже — те, у которых есть строка в
// локали; ключ собирается шаблоном, поэтому отсутствие строки ломает typecheck. Причина вне
// набора (например, `sessionConflict.stopping`) получает базовый текст кода.

const UNSUPPORTED_FIELDS = ['colorMode', 'resolution', 'paperSize'] as const;
const UNREACHABLE_REASONS = [
  'refused',
  'timeout',
  'dns',
  'reset',
  'tls',
  'network',
  'other',
] as const;
const CONFLICT_REASONS = [
  'passRunning',
  'noRunningPass',
  'notInterrupted',
  'paramsUnknown',
  'noSession',
] as const;

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** Текст ошибки как самостоятельная фраза — с заглавной буквы. */
export function errorText(t: TFunction, error: DomainError): string {
  const { code, details } = error;
  const reason = details?.reason;
  const field = details?.field;
  if (code === 'scanParamsUnsupported' && includes(UNSUPPORTED_FIELDS, field)) {
    return t(`errorReasons.scanParamsUnsupported.${field}`);
  }
  if (code === 'scannerUnreachable' && includes(UNREACHABLE_REASONS, reason)) {
    return t(`errorReasons.scannerUnreachable.${reason}`);
  }
  if (code === 'sessionConflict' && includes(CONFLICT_REASONS, reason)) {
    return t(`errorReasons.sessionConflict.${reason}`);
  }
  if (code === 'pageUnavailable' && reason === 'lost') {
    return t('errorReasons.pageUnavailable.lost');
  }
  return t(`errors.${code}`);
}

/** Тот же текст для подстановки в составное сообщение: первая буква понижена. */
export function errorTextInline(t: TFunction, error: DomainError): string {
  const text = errorText(t, error);
  return text.charAt(0).toLowerCase() + text.slice(1);
}
