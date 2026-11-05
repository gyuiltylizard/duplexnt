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
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
 * Файлы, которые страж пропускает целиком. Каждое исключение печатается в отчёте. Список пуст с
 * B-40: настоящие адрес и UUID устройства в docs/duplexnt-tech.md заменены заглушками, а история
 * переписана перед открытием репозитория. Механизм оставлен на случай осознанного исключения;
 * тесты подставляют свой список через `GuardOptions.exempt`.
 */
export const EXEMPT_FILES: readonly string[] = [];

// --- Паттерны ------------------------------------------------------------------------------

export type ViolationKind =
  'uuid' | 'ipv4' | 'ipv6' | 'mac' | 'fingerprint' | 'hostname' | 'known-value';

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly kind: ViolationKind;
  readonly excerpt: string;
}

// Окружение отсекает только продолжение hex-цепочки: UUID в имени файла (`scan-<uuid>.xml`),
// перед суффиксом (`<uuid>-caps`) и в URL-кодировке (`urn%3Auuid%3A<uuid>`) — тоже UUID.
// `%3A` кончается на hex-цифру, поэтому процентная кодировка слева разрешена отдельно.
const UUID =
  /(?:(?<![0-9a-f])|(?<=%[0-9a-f]{2}))[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi;

// Ровно четыре части: ни слева, ни справа нет продолжения вида «.5» — иначе это версия 1.2.3.4.5.
const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\.?\d)/g;

// Только формы с `::` и полная из восьми групп: время вида 12:34:56 сюда не попадает.
const IPV6 =
  /(?<![\w:.])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?)(?![\w:])/gi;

// Цепочка hex-пар через `:` или `-`: шесть пар — MAC, шестнадцать и больше — отпечаток
// сертификата (MD5, SHA-1, SHA-256). Берётся вся цепочка целиком, поэтому `MAC:00:1A:…`, где
// метка сама похожа на hex-пару, тоже ловится. Время вида 12:34:56 — три пары, не цепочка.
const HEX_PAIR_CHAIN =
  /(?<![0-9a-f])[0-9a-f]{2}([:-])(?:[0-9a-f]{2}\1){4,}[0-9a-f]{2}(?![0-9a-f])/gi;
const FINGERPRINT_MIN_PAIRS = 16;

// Две ветки с РАЗНЫМ окружением. Заводское имя Epson (EPSON + шесть hex — последние байты MAC)
// идентифицирует устройство с любым суффиксом и в любом соседстве: `.lan`, `.fritz.box`,
// `._uscan._tcp.local`, `-2`, `usb-…_caps`. Произвольные имена `.local` ловятся осторожнее:
// имена файлов вроде `.env.local` и `config.local.yaml` отсекаются окружением.
const HOSTNAME =
  /(?<![0-9a-z])EPSON[0-9a-f]{6}(?![0-9a-f])(?:\.local(?![\w-]))?|(?<![\w.-])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.local(?!\.?[\w-])/gi;

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

  for (const match of text.matchAll(HEX_PAIR_CHAIN)) {
    const pairs = (match[0].length + 1) / 3;
    found.push({ kind: pairs >= FINGERPRINT_MIN_PAIRS ? 'fingerprint' : 'mac', excerpt: match[0] });
  }

  for (const match of text.matchAll(HOSTNAME)) {
    if (!ALLOWED_HOSTNAMES.has(match[0].toLowerCase())) {
      found.push({ kind: 'hostname', excerpt: match[0] });
    }
  }

  return found;
}

const splitLines = (text: string): string[] => text.split(/\r?\n/);

export function scanText(text: string, file: string): Violation[] {
  return splitLines(text).flatMap((line, index) =>
    scanLine(line).map((found) => ({ file, line: index + 1, ...found })),
  );
}

// Вторая форма значения — без разделителей: MAC через дефис вместо двоеточия, отпечаток
// сплошным hex, UUID без дефисов. Только для достаточно длинных чисто шестнадцатеричных
// значений: у слов и имён склейка строки дала бы случайные совпадения.
const SEPARATORS = /[\s:.-]/g;
const MIN_COMPACT_LENGTH = 8;

function compactForm(value: string): string | null {
  const compact = value.replace(SEPARATORS, '');
  return compact.length >= MIN_COMPACT_LENGTH && /^[0-9a-f]+$/.test(compact) ? compact : null;
}

export function scanForKnownValues(
  text: string,
  file: string,
  values: readonly string[],
): Violation[] {
  const needles = values.map((value) => {
    const exact = value.toLowerCase();
    return { exact, compact: compactForm(exact) };
  });
  return splitLines(text).flatMap((line, index) => {
    const haystack = line.toLowerCase();
    const compactHaystack = haystack.replace(SEPARATORS, '');
    return needles
      .filter(
        ({ exact, compact }) =>
          haystack.includes(exact) || (compact !== null && compactHaystack.includes(compact)),
      )
      .map(({ exact }) => ({
        file,
        line: index + 1,
        kind: 'known-value' as const,
        excerpt: exact,
      }));
  });
}

// --- Прогон --------------------------------------------------------------------------------

const MIN_VALUE_LENGTH = 4;

// Windows PowerShell 5.1 пишет перенаправленный вывод в UTF-16LE с BOM. Без декодирования такой
// журнал спайка выглядел бы бинарным и проходил мимо обоих механизмов. `null` — бинарный файл.
// Экспорт — для проверки блобов истории при переписывании (B-40, U8): тем же декодером.
export function decodeText(content: Buffer): string | null {
  if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) {
    return content.subarray(2).toString('utf16le');
  }
  if (content.length >= 2 && content[0] === 0xfe && content[1] === 0xff) {
    return Buffer.from(content.subarray(2)).swap16().toString('utf16le');
  }
  return content.subarray(0, 8000).includes(0) ? null : content.toString('utf8');
}

/**
 * `null` — списка нет. Пустые строки, комментарии `#` и слишком короткие значения пропускаются;
 * список, в котором после этого ничего не осталось, возвращается пустым массивом.
 */
export function loadKnownValues(root: string): string[] | null {
  const path = join(root, VALUES_FILE);
  if (!existsSync(path)) {
    return null;
  }
  return splitLines(decodeText(readFileSync(path)) ?? '')
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
  /**
   * Где лежат список значений и сырые снимки; по умолчанию — `root`. В git worktree это
   * главное рабочее дерево (B-29, KTD-13): `local-test-data/` не под git и в worktree его нет.
   */
  readonly valuesRoot?: string;
  /** Пути относительно корня, с прямыми слэшами. */
  readonly files: readonly string[];
  /** Откуда брать содержимое; по умолчанию — рабочее дерево. Hook читает застейдженное. */
  readonly read?: (file: string) => Buffer;
  /** Файлы, пропускаемые целиком; по умолчанию — EXEMPT_FILES (пуст). */
  readonly exempt?: readonly string[];
}

export interface GuardReport {
  readonly ok: boolean;
  readonly violations: Violation[];
  readonly exempted: string[];
  /** Бинарные файлы: паттерны по ним не идут, список значений — идёт. */
  readonly skippedBinary: string[];
  readonly valuesCheck: 'ran' | 'skipped';
  readonly fatal: string | null;
}

export function runGuard(options: GuardOptions): GuardReport {
  const { root, files } = options;
  const valuesRoot = options.valuesRoot ?? root;
  const read = options.read ?? ((file: string) => readFileSync(join(root, file)));

  // Пустой список — то же, что отсутствующий: иначе файл из одних комментариев рапортовал бы
  // «список значений проверен», ничего не проверив.
  const loaded = loadKnownValues(valuesRoot);
  const values = loaded !== null && loaded.length > 0 ? loaded : null;
  const fatal =
    values === null && hasRawCaptures(valuesRoot)
      ? `В ${RAW_DIR}/ лежат сырые данные устройства, а списка значений ${VALUES_FILE} нет или он пуст. ` +
        'Заполни список (UUID, серийный номер, адреса, MAC, имя хоста, отпечаток и субъект ' +
        'сертификата) — по строке на значение.'
      : null;

  const violations: Violation[] = [];
  const exempted: string[] = [];
  const skippedBinary: string[] = [];

  // Находки не в строке текста: номер строки 0, в выдержке — где именно нашлось.
  const located =
    (where: string) =>
    (violation: Violation): Violation => ({
      ...violation,
      line: 0,
      excerpt: `${where}: ${violation.excerpt}`,
    });

  const exempt = options.exempt ?? EXEMPT_FILES;
  for (const file of files) {
    if (exempt.includes(file)) {
      exempted.push(file);
      continue;
    }
    const inPatternScope = PATTERN_SCOPE.some((prefix) => file.startsWith(prefix));

    // Имя файла и каталога попадает в публичную историю так же, как содержимое.
    if (inPatternScope) {
      violations.push(...scanText(file, file).map(located('в имени файла')));
    }
    if (values !== null) {
      violations.push(...scanForKnownValues(file, file, values).map(located('в имени файла')));
    }

    const content = read(file);
    const text = decodeText(content);
    if (text === null) {
      skippedBinary.push(file);
      // Метаданные PDF и JPEG могут нести серийный номер и имя устройства.
      if (values !== null) {
        const asBytes = `${content.toString('latin1')}\n${content.toString('utf16le')}`;
        const hits = scanForKnownValues(asBytes, file, values).map(located('в бинарном файле'));
        violations.push(...hits);
      }
      continue;
    }
    if (inPatternScope) {
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
    skippedBinary,
    valuesCheck: values === null ? 'skipped' : 'ran',
    fatal,
  };
}

// --- Git -----------------------------------------------------------------------------------

function gitLines(root: string, args: readonly string[]): string[] {
  const output = execFileSync('git', [...args, '-z'], { cwd: root, encoding: 'utf8' });
  return output.split('\0').filter((line) => line !== '');
}

/**
 * Корень списка значений — главное рабочее дерево репозитория (B-29, KTD-13). В worktree
 * `process.cwd()` — соседний каталог: `local-test-data/` там нет, и страж молча пропускал бы
 * проверку списка. `--git-common-dir` в главном дереве — `.git`, в worktree — путь к `.git`
 * главного дерева; родитель этого каталога и есть корень. Вне репозитория — сам `root`.
 */
export function resolveValuesRoot(root: string): string {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return dirname(resolve(root, common));
  } catch {
    return root;
  }
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
  const valuesRoot = resolveValuesRoot(root);
  let report: GuardReport;
  try {
    report = staged
      ? runGuard({ root, valuesRoot, files: listStagedFiles(root), read: readStaged(root) })
      : runGuard({ root, valuesRoot, files: listTrackedFiles(root) });
  } catch (error) {
    // Вне репозитория `git ls-files` падает — причина нужна словами, а не стеком.
    console.error(
      `страж приватности: не удалось получить список файлов у git в ${root} — ` +
        `это git-репозиторий? (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`,
    );
    return 1;
  }
  if (valuesRoot !== root) {
    console.log(`страж приватности: список значений — из главного дерева ${valuesRoot}`);
  }

  for (const file of report.exempted) {
    console.log(`страж приватности: исключение — ${file} (см. EXEMPT_FILES)`);
  }
  for (const file of report.skippedBinary) {
    console.log(`страж приватности: бинарный файл, паттерны не применялись — ${file}`);
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

// Сравниваются настоящие пути: через junction или symlink Node отдаёт `import.meta.url` уже
// разрешённым, простое сравнение строк не совпало бы — и hook молча вышел бы с нулём.
const entry = process.argv[1];
const isCli =
  entry !== undefined &&
  existsSync(entry) &&
  realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
if (isCli) {
  process.exitCode = main(process.argv.slice(2));
}
