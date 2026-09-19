import { PROBE_TOKEN_MAX_LENGTH, type ProbeRequest } from '@shared';

// Ручная проверка входа пробы (план M0, KTD-10). Библиотека валидации приходит в M1 своим ADR,
// когда у моста появятся богатые payload'ы.
export function validateProbeRequest(input: unknown): ProbeRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('запрос пробы: ожидается объект вида { token: string }');
  }

  const token: unknown = (input as Record<string, unknown>).token;
  if (typeof token !== 'string') {
    throw new TypeError('запрос пробы: поле token должно быть строкой');
  }
  if (token.length === 0 || token.length > PROBE_TOKEN_MAX_LENGTH) {
    throw new TypeError(
      `запрос пробы: длина поля token — от 1 до ${PROBE_TOKEN_MAX_LENGTH} символов`,
    );
  }

  return { token };
}
