import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';

// Самоподписанный сертификат на лету для тестов и эмулятора (план M1, KTD-29). Ключ живёт только
// в памяти процесса и на диск не попадает. Сертификат собирается вручную в DER и подписывается
// `node:crypto`: ни `openssl` из поставки Git, ни пакета-генератора тестам не нужно — `test:all`
// не зависит от внешнего бинарника.
//
// Сертификат выписан на `localhost` и `127.0.0.1`, поэтому строгий клиент отклоняет его по одной
// причине — он самоподписанный. Ровно это и проверяет тест изоляции TLS.

export interface SelfSignedCert {
  readonly certPem: string;
  readonly keyPem: string;
  /** SHA-256 сертификата в DER, hex в нижнем регистре без разделителей. */
  readonly fingerprint: string;
}

function derLength(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...parts: Uint8Array[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const sequence = (...parts: Uint8Array[]): Buffer => der(0x30, ...parts);
const set = (...parts: Uint8Array[]): Buffer => der(0x31, ...parts);
const oid = (...bytes: number[]): Buffer => der(0x06, Buffer.from(bytes));
const utf8 = (text: string): Buffer => der(0x0c, Buffer.from(text, 'utf8'));
const bitString = (bytes: Uint8Array): Buffer => der(0x03, Buffer.from([0]), bytes);
// Положительное целое: старший бит первого байта обязан быть нулевым.
const positiveInteger = (bytes: Uint8Array): Buffer =>
  der(0x02, (bytes[0] ?? 0) >= 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);

function utcTime(date: Date): Buffer {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const text =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  return der(0x17, Buffer.from(text, 'ascii'));
}

const OID_ECDSA_WITH_SHA256 = oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02);
const OID_COMMON_NAME = oid(0x55, 0x04, 0x03);
const OID_SUBJECT_ALT_NAME = oid(0x55, 0x1d, 0x11);

const DAY_MS = 24 * 60 * 60 * 1000;

export function createSelfSignedCert(commonName = 'duplexnt-test'): SelfSignedCert {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  const algorithm = sequence(OID_ECDSA_WITH_SHA256);
  const name = sequence(set(sequence(OID_COMMON_NAME, utf8(commonName))));
  const serial = randomBytes(8);
  serial[0] = (serial[0] ?? 0) & 0x7f || 1;

  const subjectAltName = sequence(
    der(0x82, Buffer.from('localhost', 'ascii')),
    der(0x87, Buffer.from([127, 0, 0, 1])),
  );
  const extensions = der(0xa3, sequence(sequence(OID_SUBJECT_ALT_NAME, der(0x04, subjectAltName))));

  const now = Date.now();
  const toBeSigned = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    positiveInteger(serial),
    algorithm,
    name,
    sequence(utcTime(new Date(now - DAY_MS)), utcTime(new Date(now + 30 * DAY_MS))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  );
  const certificate = sequence(
    toBeSigned,
    algorithm,
    bitString(sign('sha256', toBeSigned, privateKey)),
  );

  // Разбор собственным классом Node — проверка, что DER собран верно; иначе тест упал бы позже
  // невнятной ошибкой рукопожатия.
  const parsed = new X509Certificate(certificate);
  if (!parsed.verify(publicKey)) {
    throw new Error('самоподписанный сертификат не прошёл проверку подписи');
  }

  return {
    certPem: parsed.toString(),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    fingerprint: createHash('sha256').update(certificate).digest('hex'),
  };
}
