import { PROBE_TOKEN_MAX_LENGTH } from '@shared';
import { describe, expect, it } from 'vitest';
import { validateProbeRequest } from './validate-probe-request';

describe('validateProbeRequest', () => {
  it('возвращает токен обычной длины как есть', () => {
    expect(validateProbeRequest({ token: 'proof-shell' })).toEqual({ token: 'proof-shell' });
  });

  it('принимает токен ровно предельной длины', () => {
    const token = 'x'.repeat(PROBE_TOKEN_MAX_LENGTH);
    expect(validateProbeRequest({ token })).toEqual({ token });
  });

  it('не тащит в результат лишние поля входа', () => {
    expect(validateProbeRequest({ token: 'a', extra: 1 })).toEqual({ token: 'a' });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['число', 42],
    ['строка вместо объекта', 'proof-shell'],
    ['массив', ['proof-shell']],
  ])('отклоняет вход не-объект: %s', (_name, input) => {
    expect(() => validateProbeRequest(input)).toThrow(TypeError);
    expect(() => validateProbeRequest(input)).toThrow(/запрос пробы/);
  });

  it.each([
    ['нет поля', {}],
    ['undefined', { token: undefined }],
    ['число', { token: 42 }],
    ['объект', { token: { value: 'x' } }],
    ['массив', { token: ['x'] }],
  ])('отклоняет токен не-строку с названием поля: %s', (_name, input) => {
    expect(() => validateProbeRequest(input)).toThrow(TypeError);
    expect(() => validateProbeRequest(input)).toThrow(/token/);
  });

  it('отклоняет пустую строку и строку длиннее лимита', () => {
    expect(() => validateProbeRequest({ token: '' })).toThrow(/token/);
    expect(() => validateProbeRequest({ token: 'x'.repeat(PROBE_TOKEN_MAX_LENGTH + 1) })).toThrow(
      TypeError,
    );
  });
});
