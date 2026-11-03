import type { ScannerInfo, ScannerState, ScanParams } from '@shared';
import { describe, expect, it } from 'vitest';
import { addressOf, isPassReplaced, reconnectAddress, scannerLabel } from './scanner-address';

const PARAMS: ScanParams = { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' };
const SCANNER: ScannerInfo = {
  name: 'ScanPro 200',
  scheme: 'https',
  host: '192.0.2.10',
  port: 443,
};
const OTHER: ScannerInfo = { name: 'ScanPro 300', scheme: 'https', host: '192.0.2.20', port: 443 };

const ready = (scanner: ScannerInfo): ScannerState => ({
  kind: 'ready',
  scanner,
  options: { colorModes: [], resolutions: [], paperSizes: [] },
  params: PARAMS,
});

describe('адрес и имя сканера', () => {
  it('адрес — хост с портом, имя — имя или хост', () => {
    expect(addressOf(SCANNER)).toBe('192.0.2.10:443');
    expect(scannerLabel(SCANNER)).toBe('ScanPro 200');
    expect(scannerLabel({ ...SCANNER, name: null })).toBe('192.0.2.10');
  });

  it('«Подключить заново» без сканера — модалка без адреса', () => {
    expect(reconnectAddress({ kind: 'none' })).toBeUndefined();
    expect(reconnectAddress(ready(SCANNER))).toBe('192.0.2.10:443');
  });
});

describe('isPassReplaced (B-29, KTD-10)', () => {
  it('сканер готов на хосте сканера прохода — проход заменён; порт и имя не важны', () => {
    expect(isPassReplaced(ready(SCANNER), SCANNER)).toBe(true);
    expect(
      isPassReplaced(ready({ ...SCANNER, name: null, port: 80, scheme: 'http' }), SCANNER),
    ).toBe(true);
  });

  it('другой хост, сканер не готов или сканер прохода неизвестен — не заменён', () => {
    expect(isPassReplaced(ready(OTHER), SCANNER)).toBe(false);
    expect(isPassReplaced({ kind: 'none' }, SCANNER)).toBe(false);
    expect(
      isPassReplaced(
        { kind: 'otherDevice', scanner: SCANNER, error: null, params: PARAMS },
        SCANNER,
      ),
    ).toBe(false);
    expect(isPassReplaced(ready(SCANNER), null)).toBe(false);
  });
});
