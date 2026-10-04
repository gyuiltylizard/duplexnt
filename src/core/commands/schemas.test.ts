import { PROBE_TOKEN_MAX_LENGTH } from '@shared';
import { describe, expect, it } from 'vitest';
import { parseInput, probeRequestSchema } from './schemas';

const parseProbe = (input: unknown) => parseInput(probeRequestSchema, input);

describe('parseInput: запрос пробы', () => {
  it('возвращает токен обычной длины как есть', () => {
    expect(parseProbe({ token: 'proof-shell' })).toEqual({
      ok: true,
      value: { token: 'proof-shell' },
    });
  });

  it('принимает токен ровно предельной длины', () => {
    const token = 'x'.repeat(PROBE_TOKEN_MAX_LENGTH);
    expect(parseProbe({ token })).toEqual({ ok: true, value: { token } });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['число', 42],
    ['строка вместо объекта', 'proof-shell'],
    ['массив', ['proof-shell']],
  ])('вход не-объект — отказ с кодом неверного входа, а не исключение: %s', (_name, input) => {
    expect(parseProbe(input)).toEqual({
      ok: false,
      error: { code: 'invalidInput', details: { field: '', problem: 'invalid_type' } },
    });
  });

  it.each([
    ['нет поля', {}],
    ['undefined', { token: undefined }],
    ['число', { token: 42 }],
    ['объект', { token: { value: 'x' } }],
    ['массив', { token: ['x'] }],
  ])('токен не-строка — отказ называет поле: %s', (_name, input) => {
    expect(parseProbe(input)).toEqual({
      ok: false,
      error: { code: 'invalidInput', details: { field: 'token', problem: 'invalid_type' } },
    });
  });

  it('типы не приводятся: число-строка и объект-обёртка не становятся строкой', () => {
    expect(parseProbe({ token: 7 }).ok).toBe(false);
    expect(parseProbe({ token: new String('x') }).ok).toBe(false);
  });

  it('пустая строка и строка длиннее лимита — отказ с названием нарушения', () => {
    expect(parseProbe({ token: '' })).toEqual({
      ok: false,
      error: { code: 'invalidInput', details: { field: 'token', problem: 'too_small' } },
    });
    expect(parseProbe({ token: 'x'.repeat(PROBE_TOKEN_MAX_LENGTH + 1) })).toEqual({
      ok: false,
      error: { code: 'invalidInput', details: { field: 'token', problem: 'too_big' } },
    });
  });

  it('лишнее поле — отказ: схема строгая', () => {
    expect(parseProbe({ token: 'a', extra: 1 })).toEqual({
      ok: false,
      error: { code: 'invalidInput', details: { field: '', problem: 'unrecognized_keys' } },
    });
  });

  it('значение входа в детали отказа не попадает', () => {
    const result = parseProbe({
      token: 'x'.repeat(PROBE_TOKEN_MAX_LENGTH + 1),
      secret: 'не-наружу',
    });

    expect(JSON.stringify(result)).not.toContain('не-наружу');
    expect(JSON.stringify(result)).not.toContain('xxxx');
  });
});
