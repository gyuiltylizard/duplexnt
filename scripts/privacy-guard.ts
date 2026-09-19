// Страж приватности (план M0, KTD-22, KTD-34). Репозиторий публичный, а спайк и фикстуры
// снимают с устройства данные, которые его идентифицируют; утечка в историю необратима.
//
// Один модуль, два входа:
//   - тест test/guards/privacy-guard.test.ts — все отслеживаемые файлы, в `npm test`;
//   - pre-commit — застейдженное содержимое: `node scripts/privacy-guard.ts --staged`.
//
// Два механизма:
//   1. ПАТТЕРНЫ — то, у чего узнаваемая форма: UUID, IPv4, IPv6, MAC, имена хостов. Работают
//      только в PATTERN_SCOPE — там, куда попадают данные устройства.
//   2. СПИСОК ЗНАЧЕНИЙ — то, у чего формы нет: серийный номер, отпечаток и субъект сертификата,
//      имя хоста без `.local`. Git-игнорируемый файл VALUES_FILE, по строке на значение.
//      Проверяются ВСЕ файлы, без ограничения областью.
//
// Файл запускается Node напрямую (снятие типов), поэтому здесь нет enum, namespace и
// parameter properties, а импорты — только `node:*`.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Плейсхолдеры: чем заменяются настоящие значения в фикстурах и журналах -----------------

/** Заведомо фальшивый UUID. */
export const PLACEHOLDER_UUID = '00000000-0000-4000-8000-000000000000';
/** Адрес из документационного диапазона RFC 5737. */
export const PLACEHOLDER_IPV4 = '192.0.2.10';
export const PLACEHOLDER_HOST = 'EPSON000000.local';
export const PLACEHOLDER_SERIAL = 'X000000000';

// --- Области -------------------------------------------------------------------------------

export const PATTERN_SCOPE = ['test/fixtures/', 'docs/solutions/', 'docs/decisions/', 'spikes/'];

/** Список настоящих значений. Заполняется ПЕРВЫМ шагом после любого снятия данных с устройства. */
export const VALUES_FILE = 'local-test-data/privacy-values.txt';
/** Сырые снимки с устройства. Есть файлы здесь, а списка значений нет — страж падает. */
export const RAW_DIR = 'local-test-data/device';

/**
 * Файлы, которые страж пропускает целиком. Каждое исключение печатается в отчёте.
 *
 * docs/duplexnt-tech.md: содержит настоящий UUID тестового устройства и его адрес, и они уже в
 * истории. Чистка — решение автора до первого push в публичный remote (план M0 → Open
 * Questions). До решения файл стоит здесь, иначе список значений блокировал бы каждый коммит.
 */
export const EXEMPT_FILES = ['docs/duplexnt-tech.md'];

// --- Паттерны ------------------------------------------------------------------------------

export type ViolationKind = 'uuid' | 'ipv4' | 'ipv6' | 'mac' | 'hostname' | 'known-value';

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly kind: ViolationKind;
  readonly excerpt: string;
}

const UUID =
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/gi;

// Ровно четыре части: ни слева, ни справа нет продолжения вида «.5» — иначе это версия 1.2.3.4.5.
const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\.?\d)/g;

// Только формы с `::` и полная из восьми групп: время вида 12:34:56 сюда не попадает.
const IPV6 =
  /(?<![\w:.])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?)(?![\w:])/gi;

const MAC = /(?<![0-9a-f:-])[0-9a-f]{2}([:-])[0-9a-f]{2}(?:\1[0-9a-f]{2}){4}(?![0-9a-f:-])/gi;

// Заводские имена Epson (EPSON + шесть hex) и любые имена `.local`. Имена файлов вроде
// `.env.local` и `config.local.yaml` отсекаются окружением.
const HOSTNAME =
  /(?<![\w.-])(?:EPSON[0-9a-f]{6}(?:\.local)?|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.local)(?!\.?[\w-])/gi;

// Слева от четырёхчастного числа стоит слово «версия» и подобные, `v`, `@` — это номер версии.
// Частные адреса эта поблажка не покрывает: домашняя сеть — главный канал утечки.
const VERSION_CONTEXT =
  /(?:(?<![a-zа-яё\d])v|@|(?<![a-zа-яё])(?:version|ver\.?|firmware|build|верси[а-яё]*|прошивк[а-яё]*|сборк[а-яё]*)\s*[:=]?\s*["']?)$/i;

const ALLOWED_HOSTNAMES = new Set([PLACEHOLDER_HOST.toLowerCase(), 'epson000000']);
const ALLOWED_IPV6 = new Set(['::', '::1', 'ff02::fb']);

function isAllowedIpv4(a: number, b: number, c: number, d: number): boolean {
  if (a === 127) return true; // loopback
  if (a === 0 && b === 0 && c === 0 && d === 0) return true;
  if (a === 224 && b === 0 && c === 0 && d === 251) return true; // группа mDNS
  // Документационные диапазоны RFC 5737.
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

function isPrivateIpv4(a: number, b: number): boolean {
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isAllowedIpv6(address: string): boolean {
  const value = address.toLowerCase();
  // Документационный диапазон RFC 3849.
  return ALLOWED_IPV6.has(value) || /^2001:0?db8(?::|$)/.test(value);
}

function scanLine(text: string): { kind: ViolationKind; excerpt: string }[] {
  const found: { kind: ViolationKind; excerpt: string }[] = [];

  for (const match of text.matchAll(UUID)) {
    if (match[0].toLowerCase() !== PLACEHOLDER_UUID) {
      found.push({ kind: 'uuid', excerpt: match[0] });
    }
  }

  for (const match of text.matchAll(IPV4)) {
    const octets = match.slice(1, 5).map(Number);
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    if (octets.some((octet) => octet > 255) || isAllowedIpv4(a, b, c, d)) {
      continue;
    }
    const isVersion = VERSION_CONTEXT.test(text.slice(0, match.index));
    if (isPrivateIpv4(a, b) || !isVersion) {
      found.push({ kind: 'ipv4', excerpt: match[0] });
    }
  }

  for (const match of text.matchAll(IPV6)) {
    if (!isAllowedIpv6(match[0])) {
      found.push({ kind: 'ipv6', excerpt: match[0] });
    }
  }

  for (const match of text.matchAll(MAC)) {
    found.push({ kind: 'mac', excerpt: match[0] });
  }

  for (const match of text.matchAll(HOSTNAME)) {
    if (!ALLOWED_HOSTNAMES.has(match[0].toLowerCase())) {
      found.push({ kind: 'hostname', excerpt: match[0] });
    }
  }

  return found;
}

export function scanText(text: string, file: string): Violation[] {
  return text
    .split(/\r?\n/)
    .flatMap((line, index) => scanLine(line).map((found) => ({ file, line: index + 1, ...found })));
}

export function scanForKnownValues(
  text: string,
  file: string,
  values: readonly string[],
): Violation[] {
  const needles = values.map((value) => value.toLowerCase());
  return text.split(/\r?\n/).flatMap((line, index) => {
    const haystack = line.toLowerCase();
    return needles
      .filter((needle) => haystack.includes(needle))
      .map((needle) => ({ file, line: index + 1, kind: 'known-value' as const, excerpt: needle }));
  });
}

// --- Прогон --------------------------------------------------------------------------------

const MIN_VALUE_LENGTH = 4;

/** `null` — списка нет. Пустые строки, комментарии `#` и слишком короткие значения пропускаются. */
export function loadKnownValues(root: string): string[] | null {
  const path = join(root, VALUES_FILE);
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= MIN_VALUE_LENGTH && !line.startsWith('#'));
}

export function hasRawCaptures(root: string): boolean {
  const dir = join(root, RAW_DIR);
  if (!existsSync(dir)) {
    return false;
  }
  return readdirSync(dir, { recursive: true, withFileTypes: true }).some((entry) => entry.isFile());
}

export interface GuardOptions {
  readonly root: string;
  /** Пути относительно корня, с прямыми слэшами. */
  readonly files: readonly string[];
  /** Откуда брать содержимое; по умолчанию — рабочее дерево. Hook читает застейдженное. */
  readonly read?: (file: string) => Buffer;
}

export interface GuardReport {
  readonly ok: boolean;
  readonly violations: Violation[];
  readonly exempted: string[];
  readonly valuesCheck: 'ran' | 'skipped';
  readonly fatal: string | null;
}

const isBinary = (content: Buffer): boolean => content.subarray(0, 8000).includes(0);

export function runGuard(options: GuardOptions): GuardReport {
  const { root, files } = options;
  const read = options.read ?? ((file: string) => readFileSync(join(root, file)));

  const values = loadKnownValues(root);
  const fatal =
    values === null && hasRawCaptures(root)
      ? `В ${RAW_DIR}/ лежат сырые данные устройства, а списка значений ${VALUES_FILE} нет. ` +
        'Заполни список (UUID, серийный номер, адреса, MAC, имя хоста, отпечаток и субъект ' +
        'сертификата) — по строке на значение.'
      : null;

  const violations: Violation[] = [];
  const exempted: string[] = [];

  for (const file of files) {
    if (EXEMPT_FILES.includes(file)) {
      exempted.push(file);
      continue;
    }
    const content = read(file);
    if (isBinary(content)) {
      continue;
    }
    const text = content.toString('utf8');
    if (PATTERN_SCOPE.some((prefix) => file.startsWith(prefix))) {
      violations.push(...scanText(text, file));
    }
    if (values !== null) {
      violations.push(...scanForKnownValues(text, file, values));
    }
  }

  return {
    ok: fatal === null && violations.length === 0,
    violations,
    exempted,
    valuesCheck: values === null ? 'skipped' : 'ran',
    fatal,
  };
}

// --- Git -----------------------------------------------------------------------------------

function gitLines(root: string, args: readonly string[]): string[] {
  const output = execFileSync('git', [...args, '-z'], { cwd: root, encoding: 'utf8' });
  return output.split('\0').filter((line) => line !== '');
}

export function listTrackedFiles(root: string): string[] {
  return gitLines(root, ['ls-files']).filter((file) => existsSync(join(root, file)));
}

export function listStagedFiles(root: string): string[] {
  return gitLines(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
}

export function readStaged(root: string): (file: string) => Buffer {
  return (file) =>
    execFileSync('git', ['show', `:${file}`], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
}

// --- CLI -----------------------------------------------------------------------------------

function main(argv: readonly string[]): number {
  const root = process.cwd();
  const staged = argv.includes('--staged');
  const report = staged
    ? runGuard({ root, files: listStagedFiles(root), read: readStaged(root) })
    : runGuard({ root, files: listTrackedFiles(root) });

  for (const file of report.exempted) {
    console.log(`страж приватности: исключение — ${file} (см. EXEMPT_FILES)`);
  }
  if (report.fatal !== null) {
    console.error(`страж приватности: ${report.fatal}`);
  }
  for (const violation of report.violations) {
    console.error(
      `${violation.file}:${String(violation.line)}: [${violation.kind}] ${violation.excerpt}`,
    );
  }
  if (!report.ok) {
    console.error(
      '\nстраж приватности: коммит остановлен. Замени значения плейсхолдерами ' +
        `(${PLACEHOLDER_UUID}, ${PLACEHOLDER_IPV4}, ${PLACEHOLDER_HOST}); сырое — в local-test-data/.`,
    );
    return 1;
  }
  const scope = staged ? 'застейдженное' : 'все отслеживаемые файлы';
  const list = report.valuesCheck === 'ran' ? 'список значений проверен' : 'списка значений нет';
  console.log(`страж приватности: чисто (${scope}; ${list})`);
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
