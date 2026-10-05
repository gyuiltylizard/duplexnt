import type { Result } from '../../src/shared';

/** Разворачивает успех конверта; отказ — падение теста с кодом и деталями. */
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`отказ: ${result.error.code} ${JSON.stringify(result.error.details ?? {})}`);
  }
  return result.value;
}
