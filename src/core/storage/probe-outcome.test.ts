import { describe, expect, it } from 'vitest';
import { fail, ok, type Result } from '@shared';
import { ET_3850, readFixtureText } from '../../../test/support/fixtures';
import { probeScanner, type ConnectedScanner } from '../escl/connect';
import { classifyProbe, type ProbeClass } from './probe-outcome';
import { storedScannerOf, type StoredScanner } from './stored-scanner';

// Классы исхода пробы запомненного сканера (M5, KTD1): таблица из High-Level Technical Design
// плана M5 — каждый код в свой класс.

const CAPABILITIES = readFixtureText(...ET_3850, 'ScannerCapabilities.xml');
const FINGERPRINT = 'ab'.repeat(32);

/** Исправный сканер на адресе: проба на подставном транспорте. */
async function probed(capabilities = CAPABILITIES): Promise<ConnectedScanner> {
  const result = await probeScanner(
    { scheme: 'https', host: '192.0.2.10', port: 443, basePath: '/eSCL', fingerprint: null },
    {
      createTransport: () => ({
        request: () =>
          Promise.resolve(
            ok({
              status: 200,
              location: null,
              contentType: 'text/xml',
              fingerprint: FINGERPRINT,
              body: new TextEncoder().encode(capabilities),
            }),
          ),
        stream: () => Promise.reject(new Error('страницы не запрашиваются')),
        close: () => undefined,
      }),
    },
  );
  if (!result.ok) {
    throw new Error(`проба отклонена: ${result.error.code}`);
  }
  return result.value;
}

async function remembered(): Promise<StoredScanner> {
  return storedScannerOf(await probed());
}

describe('классификация исхода пробы (M5, KTD1)', () => {
  it('то же устройство — ok', async () => {
    const scanner = await remembered();

    expect(classifyProbe(scanner, ok(await probed()))).toBe('ok');
  });

  it('исправный сканер с другим UUID — foreign', async () => {
    const scanner = await remembered();
    const other = CAPABILITIES.replace(
      /<scan:UUID>[^<]*<\/scan:UUID>/,
      '<scan:UUID>00000000-0000-0000-0000-000000000000</scan:UUID>',
    );

    expect(classifyProbe(scanner, ok(await probed(other)))).toBe('foreign');
  });

  it.each<[string, Result<never>, ProbeClass]>([
    ...['timeout', 'refused', 'dns', 'reset', 'tls', 'network', 'other'].map(
      (reason): [string, Result<never>, ProbeClass] => [
        `не отвечает: ${reason}`,
        fail('scannerUnreachable', { reason }),
        'silent',
      ],
    ),
    ['чужой сертификат', fail('scannerCertificateChanged'), 'foreign'],
    ['не сканер: 404', fail('notEsclScanner', { status: 404 }), 'foreign'],
    ['не сканер: 401', fail('notEsclScanner', { status: 401 }), 'foreign'],
    ['не сканер: страница HTML', fail('notEsclScanner'), 'foreign'],
    ['сканер без JPEG', fail('scannerNoJpeg'), 'foreign'],
    ['параметры не годятся', fail('scanParamsUnsupported', { field: 'paperSize' }), 'foreign'],
    ['сканер без автоподачи', fail('scannerNoAdf'), 'foreign'],
    ['занят до потолка', fail('scannerBusy'), 'busy'],
    ['ответ не разобран', fail('scannerBadResponse', { reason: 'tooLarge' }), 'garbled'],
    ['сбой сканера: 500', fail('notEsclScanner', { status: 500 }), 'garbled'],
    ['сбой сканера: 502', fail('notEsclScanner', { status: 502 }), 'garbled'],
    ['отмена', fail('canceled'), 'canceled'],
  ])('%s → %s', async (_title, result, expected) => {
    expect(classifyProbe(await remembered(), result)).toBe(expected);
  });
});
