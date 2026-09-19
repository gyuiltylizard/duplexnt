import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_HOST,
  PLACEHOLDER_IPV4,
  PLACEHOLDER_UUID,
  RAW_DIR,
  VALUES_FILE,
  listTrackedFiles,
  runGuard,
  scanForKnownValues,
  scanText,
} from '../../scripts/privacy-guard';

// Синтетические значения: ни одно не снято с настоящего устройства.
const SYNTHETIC_UUID = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';

const kinds = (text: string): string[] =>
  scanText(text, 'docs/solutions/x.md').map((violation) => violation.kind);

describe('scanText — паттерны', () => {
  it('плейсхолдеры чисты', () => {
    expect(
      kinds(`uuid ${PLACEHOLDER_UUID} адрес ${PLACEHOLDER_IPV4} хост ${PLACEHOLDER_HOST}`),
    ).toEqual([]);
    expect(kinds('https://198.51.100.7/eSCL и 203.0.113.250, IPv6 2001:db8::1')).toEqual([]);
  });

  it.each([
    ['uuid', `<scan:UUID>${SYNTHETIC_UUID}</scan:UUID>`],
    ['uuid', `urn:uuid:${SYNTHETIC_UUID.toUpperCase()}`],
    ['ipv4', 'сканер на 192.168.1.50 отвечает'],
    ['ipv4', 'https://10.0.0.7:443/eSCL/ScannerCapabilities'],
    ['ipv4', 'адаптер 172.16.4.2'],
    ['ipv4', 'link-local 169.254.12.34'],
    ['ipv4', 'внешний 93.184.216.34'],
    ['ipv6', 'ответ с fe80::1c2d:3eff:fe4f:5a6b'],
    ['ipv6', 'адрес 2a02:6b8::2:242'],
    ['ipv6', 'полный 2a02:06b8:0000:0000:0000:0000:0002:0242'],
    ['mac', 'MAC 00:1A:2B:3C:4D:5E'],
    ['mac', 'mac=00-1a-2b-3c-4d-5e'],
    ['hostname', 'EPSON1A2B3C.local'],
    ['hostname', 'ty=EPSON1a2b3c'],
    ['hostname', 'нашёлся my-printer.local'],
    // Находки ревью M0: идентификатор рядом с `-`, `_`, расширением или чужим суффиксом.
    ['uuid', `scan-${SYNTHETIC_UUID}.xml`],
    ['uuid', `${SYNTHETIC_UUID}-caps`],
    ['uuid', `urn%3Auuid%3A${SYNTHETIC_UUID}`],
    ['hostname', 'EPSON1A2B3C.lan'],
    ['hostname', 'EPSON1A2B3C.fritz.box'],
    ['hostname', 'сервис EPSON1A2B3C._uscan._tcp.local'],
    ['hostname', 'EPSON1A2B3C-2'],
    ['hostname', 'usb-EPSON1A2B3C_caps'],
    ['mac', 'MAC:00:1A:2B:3C:4D:5E'],
    ['fingerprint', 'SHA1 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01'],
  ])('ловит %s: %s', (kind, text) => {
    expect(kinds(text)).toEqual([kind]);
  });

  it('заводское имя Epson с лишним hex-знаком — не имя хоста', () => {
    expect(kinds('артикул EPSON1A2B3C4')).toEqual([]);
  });

  it('называет файл и строку', () => {
    const [violation] = scanText('первая\nвторая 192.168.1.50\n', 'docs/solutions/0001.md');

    expect(violation).toMatchObject({ file: 'docs/solutions/0001.md', line: 2, kind: 'ipv4' });
    expect(violation?.excerpt).toContain('192.168.1.50');
  });

  it.each(['127.0.0.1', '127.8.8.8', '0.0.0.0', '224.0.0.251', '::1', 'ff02::fb'])(
    'неидентифицирующий адрес %s чист',
    (address) => {
      expect(kinds(`слушаем ${address}, порт 5353`)).toEqual([]);
      expect(kinds(`[${address}]:5353`)).toEqual([]);
    },
  );

  it('номера версий не принимаются за адрес', () => {
    expect(kinds('eSCL 2.63, pwg 1.4, libvips 8.18.6')).toEqual([]);
    expect(kinds('версия прошивки 3.0.4.1')).toEqual([]);
    expect(kinds('firmware version: 3.0.4.1, пакет foo@3.0.4.1, тег v3.0.4.1')).toEqual([]);
    expect(kinds('"chrome": "152.0.7977.130"')).toEqual([]);
    expect(kinds('сборка 1.2.3.4.5')).toEqual([]);
  });

  it('частный адрес — нарушение даже в контексте версии', () => {
    expect(kinds('версия 192.168.1.50')).toEqual(['ipv4']);
  });

  it('время, селекторы CSS и имена файлов не принимаются за адреса и хосты', () => {
    expect(kinds('прогон в 12:34:56, потом 09:05')).toEqual([]);
    expect(kinds('a::before { color: red } и std::string')).toEqual([]);
    expect(kinds('файлы .env.local и config.local.yaml')).toEqual([]);
  });
});

describe('runGuard — области и список значений', () => {
  const roots: string[] = [];

  function repo(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'duplexnt-guard-'));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('паттерны работают только в своей области', () => {
    const root = repo({
      'docs/solutions/a.md': 'адрес 192.168.1.50',
      'spikes/a.mjs': `const id = '${SYNTHETIC_UUID}';`,
      'test/fixtures/escl/a.xml': '<x>EPSON1A2B3C</x>',
      'docs/decisions/a.md': 'MAC 00:1A:2B:3C:4D:5E',
      'src/core/a.ts': "const example = '192.168.1.50';",
      'README.md': 'пример 192.168.1.50',
    });
    const report = runGuard({
      root,
      files: [
        'docs/solutions/a.md',
        'spikes/a.mjs',
        'test/fixtures/escl/a.xml',
        'docs/decisions/a.md',
        'src/core/a.ts',
        'README.md',
      ],
    });

    expect(report.violations.map((violation) => violation.file).sort()).toEqual([
      'docs/decisions/a.md',
      'docs/solutions/a.md',
      'spikes/a.mjs',
      'test/fixtures/escl/a.xml',
    ]);
    expect(report.valuesCheck).toBe('skipped');
  });

  it('строка из списка значений — нарушение в любом файле, и вне области паттернов', () => {
    const root = repo({
      [VALUES_FILE]: '# серийный номер\nX7QZ012345\n\nMy-Home-Scanner\n',
      'src/core/a.ts': "const serial = 'x7qz012345';",
      'README.md': 'хост My-Home-Scanner в сети',
      'docs/roadmap.md': 'ничего личного',
    });
    const report = runGuard({ root, files: ['src/core/a.ts', 'README.md', 'docs/roadmap.md'] });

    expect(report.valuesCheck).toBe('ran');
    expect(
      report.violations.map((violation) => `${violation.file}:${violation.kind}`).sort(),
    ).toEqual(['README.md:known-value', 'src/core/a.ts:known-value']);
  });

  it('списка нет и сырых данных нет — проверка пропущена, а не упала', () => {
    const root = repo({ 'docs/solutions/a.md': 'чисто' });
    const report = runGuard({ root, files: ['docs/solutions/a.md'] });

    expect(report.valuesCheck).toBe('skipped');
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('сырые данные есть, а списка нет — страж падает', () => {
    const root = repo({
      [`${RAW_DIR}/ScannerCapabilities.xml`]: '<сырой ответ/>',
      'docs/solutions/a.md': 'чисто',
    });
    const report = runGuard({ root, files: ['docs/solutions/a.md'] });

    expect(report.ok).toBe(false);
    expect(report.violations).toEqual([]);
    expect(report.fatal).toContain(VALUES_FILE);
  });

  it('файл из списка исключений не даёт нарушения, и исключение видно в отчёте', () => {
    const root = repo({
      [VALUES_FILE]: 'X7QZ012345\n',
      'docs/duplexnt-tech.md': 'серийный X7QZ012345',
      'README.md': 'чисто',
    });
    const report = runGuard({ root, files: ['docs/duplexnt-tech.md', 'README.md'] });

    expect(report.violations).toEqual([]);
    expect(report.exempted).toEqual(['docs/duplexnt-tech.md']);
    expect(report.ok).toBe(true);
  });

  it('идентификатор в имени файла или каталога — нарушение, даже при чистом содержимом', () => {
    const root = repo({
      'docs/solutions/EPSON1A2B3C-192.168.1.50.md': 'чисто',
      'test/fixtures/escl/EPSON1A2B3C/a.xml': '<x/>',
    });
    const report = runGuard({
      root,
      files: ['docs/solutions/EPSON1A2B3C-192.168.1.50.md', 'test/fixtures/escl/EPSON1A2B3C/a.xml'],
    });

    expect(report.ok).toBe(false);
    expect(report.violations.map((violation) => violation.kind).sort()).toEqual([
      'hostname',
      'hostname',
      'ipv4',
    ]);
  });

  it('UTF-16 из PowerShell читается как текст, а не пропускается как бинарный', () => {
    const root = repo({});
    const path = 'spikes/log.txt';
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      Buffer.from(
        `${String.fromCharCode(0xfeff)}сканер EPSON1A2B3C.local на 192.168.1.50`,
        'utf16le',
      ),
    );
    const report = runGuard({ root, files: [path] });

    expect(report.violations.map((violation) => violation.kind).sort()).toEqual([
      'hostname',
      'ipv4',
    ]);
    expect(report.skippedBinary).toEqual([]);
  });

  it('значение из списка ловится и внутри бинарного файла; пропуск виден в отчёте', () => {
    const root = repo({ [VALUES_FILE]: 'X7QZ012345' });
    const path = 'docs/solutions/scan.pdf';
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      Buffer.concat([
        Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00]),
        Buffer.from('/Serial (X7QZ012345)'),
      ]),
    );
    const report = runGuard({ root, files: [path] });

    expect(report.skippedBinary).toEqual([path]);
    expect(report.violations.map((violation) => violation.kind)).toEqual(['known-value']);
  });

  it('список есть, но пуст, а сырые данные лежат — страж падает, а не рапортует «проверен»', () => {
    const root = repo({
      [VALUES_FILE]: ['# только комментарий', '', 'ab', ''].join('\n'),
      [`${RAW_DIR}/ScannerCapabilities.xml`]: '<сырой ответ/>',
      'docs/solutions/a.md': 'чисто',
    });
    const report = runGuard({ root, files: ['docs/solutions/a.md'] });

    expect(report.valuesCheck).toBe('skipped');
    expect(report.ok).toBe(false);
    expect(report.fatal).toContain(VALUES_FILE);
  });

  it('бинарные файлы пропускаются', () => {
    const root = repo({ 'docs/solutions/a.png': `PNG${String.fromCharCode(0)} 192.168.1.50` });

    expect(runGuard({ root, files: ['docs/solutions/a.png'] }).violations).toEqual([]);
  });
});

describe('страж на самом репозитории', () => {
  it('в отслеживаемых файлах нет идентификаторов устройства и сети', () => {
    const root = process.cwd();
    const report = runGuard({ root, files: listTrackedFiles(root) });

    expect(report.fatal).toBeNull();
    expect(
      report.violations.map((v) => `${v.file}:${String(v.line)} [${v.kind}] ${v.excerpt}`),
    ).toEqual([]);
  });
});

describe('scanForKnownValues — другая запись того же значения', () => {
  it('MAC и отпечаток ловятся с другими разделителями и без них', () => {
    const values = ['00:1A:2B:3C:4D:5E'];

    expect(scanForKnownValues('mac 00-1a-2b-3c-4d-5e', 'a', values)).toHaveLength(1);
    expect(scanForKnownValues('mac 001a2b3c4d5e', 'a', values)).toHaveLength(1);
    expect(scanForKnownValues('mac 00:1A:2B:3C:4D:5E', 'a', values)).toHaveLength(1);
  });

  it('короткие и нехексовые значения сравниваются только буквально', () => {
    expect(scanForKnownValues('имя my home scanner', 'a', ['My-Home-Scanner'])).toHaveLength(0);
    expect(scanForKnownValues('хост My-Home-Scanner', 'a', ['My-Home-Scanner'])).toHaveLength(1);
  });
});
