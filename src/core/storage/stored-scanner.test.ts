import { describe, expect, it } from 'vitest';
import {
  isResumableOn,
  needsDeviceConfirmation,
  sameScanner,
  type StoredScanner,
} from './stored-scanner';

// Решение о смене устройства (B-29, KTD-6): каждая строка таблицы плана и случаи неизвестного
// UUID. Отпечатки и UUID — синтетические.

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);
const UUID_1 = '11111111-2222-4333-8444-555555555555';
const UUID_2 = '99999999-8888-4777-8666-555555555555';

const scanner = (overrides: Partial<StoredScanner> = {}): StoredScanner => ({
  scheme: 'https',
  host: '192.0.2.10',
  port: 443,
  basePath: '/eSCL',
  fingerprint: FP_A,
  uuid: UUID_1,
  name: 'ScanPro 200',
  ...overrides,
});

describe('needsDeviceConfirmation', () => {
  it('запомненного нет — первое подключение без подтверждения', () => {
    expect(needsDeviceConfirmation(null, scanner())).toBe(false);
    expect(needsDeviceConfirmation(null, scanner({ scheme: 'http', fingerprint: null }))).toBe(
      false,
    );
  });

  it('тот же отпечаток: UUID тот же или неясен — без подтверждения, даже на новом адресе', () => {
    expect(needsDeviceConfirmation(scanner(), scanner())).toBe(false);
    expect(needsDeviceConfirmation(scanner(), scanner({ uuid: null }))).toBe(false);
    expect(needsDeviceConfirmation(scanner({ uuid: null }), scanner())).toBe(false);
    expect(needsDeviceConfirmation(scanner(), scanner({ host: '192.0.2.20', port: 8443 }))).toBe(
      false,
    );
  });

  it('тот же отпечаток, другой UUID — подтверждение, адрес не важен', () => {
    expect(needsDeviceConfirmation(scanner(), scanner({ uuid: UUID_2 }))).toBe(true);
    expect(needsDeviceConfirmation(scanner(), scanner({ uuid: UUID_2, host: '192.0.2.20' }))).toBe(
      true,
    );
  });

  it('другой отпечаток при совпавшем хосте или UUID — подтверждение', () => {
    expect(needsDeviceConfirmation(scanner(), scanner({ fingerprint: FP_B }))).toBe(true);
    expect(needsDeviceConfirmation(scanner(), scanner({ fingerprint: FP_B, uuid: null }))).toBe(
      true,
    );
    expect(
      needsDeviceConfirmation(scanner(), scanner({ fingerprint: FP_B, host: '192.0.2.20' })),
    ).toBe(true);
  });

  it('HTTP вместо запомненного отпечатка при совпавшем хосте или UUID — подтверждение', () => {
    const http = scanner({ scheme: 'http', port: 80, fingerprint: null });
    expect(needsDeviceConfirmation(scanner(), http)).toBe(true);
    expect(needsDeviceConfirmation(scanner(), { ...http, uuid: null })).toBe(true);
    expect(needsDeviceConfirmation(scanner(), { ...http, host: '192.0.2.20' })).toBe(true);
  });

  it('порт и схема не сравниваются: 443 → 80 при вводе хоста без порта не обходит шаг', () => {
    const probe = scanner({ scheme: 'http', port: 80, fingerprint: null, uuid: UUID_2 });
    expect(needsDeviceConfirmation(scanner(), probe)).toBe(true);
  });

  it('запомнен без отпечатка: отпечаток или HTTP с тем же или неясным UUID — без подтверждения', () => {
    const remembered = scanner({ scheme: 'http', port: 80, fingerprint: null });
    expect(needsDeviceConfirmation(remembered, scanner())).toBe(false);
    expect(needsDeviceConfirmation(remembered, scanner({ uuid: null }))).toBe(false);
    expect(needsDeviceConfirmation(remembered, remembered)).toBe(false);
    expect(needsDeviceConfirmation(remembered, { ...remembered, uuid: null })).toBe(false);
    expect(needsDeviceConfirmation({ ...remembered, uuid: null }, scanner())).toBe(false);
  });

  it('запомнен без отпечатка: другой UUID на том же хосте — подтверждение', () => {
    const remembered = scanner({ scheme: 'http', port: 80, fingerprint: null });
    expect(needsDeviceConfirmation(remembered, scanner({ uuid: UUID_2 }))).toBe(true);
    expect(needsDeviceConfirmation(remembered, { ...remembered, uuid: UUID_2 })).toBe(true);
  });

  it('ничего не совпало — другое устройство по выбору пользователя, без подтверждения', () => {
    const elsewhere = scanner({ host: '192.0.2.20', fingerprint: FP_B, uuid: UUID_2 });
    expect(needsDeviceConfirmation(scanner(), elsewhere)).toBe(false);
    expect(needsDeviceConfirmation(scanner(), { ...elsewhere, fingerprint: null })).toBe(false);
    expect(needsDeviceConfirmation(scanner(), { ...elsewhere, uuid: null })).toBe(false);
    expect(
      needsDeviceConfirmation(scanner({ fingerprint: null }), { ...elsewhere, uuid: null }),
    ).toBe(false);
  });
});

describe('isResumableOn', () => {
  it('то же устройство по отпечатку и UUID — досканировать можно', () => {
    expect(isResumableOn(scanner(), scanner())).toBe(true);
    expect(isResumableOn(scanner(), scanner({ host: '192.0.2.20', port: 8443 }))).toBe(true);
  });

  it('проход с отпечатком, текущий без отпечатка — нельзя, хотя sameScanner снисходителен', () => {
    const http = scanner({ scheme: 'http', port: 80, fingerprint: null });
    expect(sameScanner(scanner(), http)).toBe(true);
    expect(isResumableOn(scanner(), http)).toBe(false);
  });

  it('проход без отпечатка — правило прежнее: HTTP на том же адресе, отпечаток — по UUID', () => {
    const http = scanner({ scheme: 'http', port: 80, fingerprint: null, uuid: null });
    expect(isResumableOn(http, http)).toBe(true);
    expect(isResumableOn(http, { ...http, port: 8080 })).toBe(false);
    expect(isResumableOn(scanner({ fingerprint: null }), scanner())).toBe(true);
    expect(isResumableOn(scanner({ fingerprint: null }), scanner({ uuid: UUID_2 }))).toBe(false);
  });

  it('другой отпечаток — нельзя', () => {
    expect(isResumableOn(scanner(), scanner({ fingerprint: FP_B }))).toBe(false);
  });
});
