// Разбор токенов дизайн-системы. Источник правды — блок `:root` в
// docs/design/DESIGN_SYSTEM.md; src/renderer/src/styles/tokens.css — его копия. Этим модулем
// пользуются тест дрейфа (test/design/tokens-drift.test.ts) и скрипт переноса
// (scripts/sync-design-tokens.ts).

/** Пути от корня репозитория: источник правды и его сгенерированная копия. */
export const DESIGN_SYSTEM_PATH = 'docs/design/DESIGN_SYSTEM.md';
export const TOKENS_CSS_PATH = 'src/renderer/src/styles/tokens.css';

const ROOT_HEADING = '## Блок :root';

/** Содержимое css-блока под заголовком «Блок :root» — вместе с `:root { … }`. */
export function extractRootBlock(markdown: string): string {
  const headingAt = markdown.indexOf(ROOT_HEADING);
  const fence = /```css\r?\n([\s\S]*?)\r?\n```/.exec(markdown.slice(Math.max(headingAt, 0)));
  if (headingAt === -1 || fence?.[1] === undefined) {
    throw new Error(`В дизайн-системе не найден css-блок под заголовком «${ROOT_HEADING}»`);
  }
  return fence[1];
}

/** Пары «имя — значение»; пробелы и переносы в значении нормализуются. */
export function parseCustomProperties(css: string): Map<string, string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const properties = new Map<string, string>();
  // У последнего объявления в минифицированном CSS точки с запятой нет — конец по `}`.
  for (const match of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)(?:;|(?=\s*\}))/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) {
      properties.set(name, normalizeValue(value));
    }
  }
  return properties;
}

function normalizeValue(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
}

const FIX = 'правь src/renderer/src/styles/tokens.css (`npm run tokens:sync`), не документ';

/** Пустой массив — дрейфа нет. Каждая строка называет токен и говорит, что править. */
export function describeDrift(
  expected: ReadonlyMap<string, string>,
  actual: ReadonlyMap<string, string>,
): string[] {
  const drift: string[] = [];
  for (const [name, value] of expected) {
    const found = actual.get(name);
    if (found === undefined) {
      drift.push(`${name}: нет в tokens.css, в дизайн-системе «${value}» — ${FIX}`);
    } else if (found !== value) {
      drift.push(`${name}: в tokens.css «${found}», в дизайн-системе «${value}» — ${FIX}`);
    }
  }
  for (const name of actual.keys()) {
    if (!expected.has(name)) {
      drift.push(`${name}: есть в tokens.css, но нет в дизайн-системе — ${FIX}`);
    }
  }
  return drift;
}
