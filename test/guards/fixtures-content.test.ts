import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_IPV4,
  PLACEHOLDER_SERIAL,
  PLACEHOLDER_UUID,
  scanText,
} from '../../scripts/privacy-guard';

// Разбор XML — дело M1; здесь фикстуры проверяются по тексту, парсер не нужен.
const DIR = 'test/fixtures/escl/et-3850';
const read = (name: string): string => readFileSync(resolve(DIR, name), 'utf8');

const tagValues = (xml: string, tag: string): string[] =>
  [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((match) => match[1] ?? '');

describe('ScannerCapabilities ET-3850', () => {
  const xml = read('ScannerCapabilities.xml');

  it('UUID и серийный номер — плейсхолдеры', () => {
    expect(tagValues(xml, 'scan:UUID')).toEqual([PLACEHOLDER_UUID]);
    expect(tagValues(xml, 'pwg:SerialNumber')).toEqual([PLACEHOLDER_SERIAL]);
  });

  it('хост во всех URI — плейсхолдер, включая административную ссылку и иконку', () => {
    const uris = [...xml.matchAll(/<(?:\w+:)?\w*UR[IL]\w*>\s*(https?:\/\/[^<]+)</gi)].map(
      (match) => new URL(match[1] ?? '').hostname,
    );

    expect(uris.length).toBeGreaterThanOrEqual(2);
    expect(new Set(uris)).toEqual(new Set([PLACEHOLDER_IPV4]));
  });

  it('зачистка не съела содержимое', () => {
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toContain('<scan:AdfSimplexInputCaps>');
    expect(xml).toContain('<scan:PlatenInputCaps>');
    expect(xml).toContain('<pwg:MakeAndModel>EPSON ET-3850 Series</pwg:MakeAndModel>');
    expect(xml.trimEnd().endsWith('</scan:ScannerCapabilities>')).toBe(true);
    // Следы неудачной подстановки групп регулярного выражения.
    expect(xml).not.toMatch(/\$\d/);
  });

  it('страж не находит в ней идентификаторов', () => {
    expect(scanText(xml, `${DIR}/ScannerCapabilities.xml`)).toEqual([]);
  });
});

describe('ScannerStatus ET-3850', () => {
  const xml = read('ScannerStatus.xml');

  it('снят в покое, секции заданий нет', () => {
    expect(tagValues(xml, 'pwg:State')).toEqual(['Idle']);
    expect(xml).not.toContain('Jobs');
    expect(xml).not.toContain('JobUuid');
  });

  it('ни одного неплейсхолдерного идентификатора', () => {
    expect(scanText(xml, `${DIR}/ScannerStatus.xml`)).toEqual([]);
    expect(xml.trimEnd().endsWith('</scan:ScannerStatus>')).toBe(true);
  });
});

describe('AE8: подстановка идентификатора в фикстуру ловится', () => {
  it('синтетический UUID и частный адрес дают нарушения', () => {
    const tampered = read('ScannerCapabilities.xml')
      .replace(PLACEHOLDER_UUID, '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed')
      .replace(PLACEHOLDER_IPV4, '192.168.1.50');

    const kinds = scanText(tampered, `${DIR}/ScannerCapabilities.xml`).map((v) => v.kind);
    expect(kinds).toContain('uuid');
    expect(kinds).toContain('ipv4');
  });
});
