import { builtinModules } from 'node:module';
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import type { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

// ---------------------------------------------------------------------------------------------
// Границы слоёв (см. docs/duplexnt.md → «Архитектура»).
//
// Flat config не сливает опции одного правила между блоками — побеждает последний совпавший.
// Поэтому каждый блок несёт ПОЛНЫЙ набор запретов своего каталога, а собирает их один хелпер.
// Паттерны покрывают и алиасы (`@core`), и относительные пути (`../core/…`). Алиасы повторяют
// tooling/aliases.ts и `paths` в tsconfig.base.json.
//
// Блоки экспортируются отдельно: тест test/lint/layer-boundaries.test.ts собирает из них
// свой экземпляр ESLint с парсером без типовой информации — синтетический файл не входит
// ни в один проект TypeScript, и типизированный линт его не примет.
// ---------------------------------------------------------------------------------------------

interface Restriction {
  readonly regex: string;
  readonly message: string;
}

const layerRegex = (dir: string, alias?: string): string => {
  const relative = String.raw`(\.\./)+(.*/)?${dir}(/.*)?`;
  return alias === undefined ? `^(${relative})$` : `^(${alias}(/.*)?|${relative})$`;
};

const ELECTRON: Restriction = {
  regex: '^electron(/.*)?$',
  message:
    'Electron сюда нельзя. Адаптеры к Electron живут в src/main; ядро получает зависимости аргументами.',
};
// И `node:fs`, и голое `fs`: в renderer и shared голое имя ловит typecheck (там нет типов Node),
// а в preload — ничто, кроме этого правила; под sandbox оно всплыло бы только ошибкой в рантайме.
const BUILTINS = builtinModules.filter((name) => !name.startsWith('_')).join('|');
const NODE: Restriction = {
  regex: `^(node:.*|(${BUILTINS})(/.*)?)$`,
  message: 'Node-модули сюда нельзя: сеть и файлы — работа ядра (src/core), доступ — через мост.',
};
const CORE: Restriction = {
  regex: layerRegex('core', '@core'),
  message: 'Ядро доступно только из src/main. Интерфейсу — команда моста (src/shared/bridge.ts).',
};
const MAIN: Restriction = {
  regex: layerRegex('main'),
  message: 'src/main — верхний слой, его никто не импортирует. Общее — в src/shared.',
};
const PRELOAD: Restriction = {
  regex: layerRegex('preload'),
  message: 'src/preload никто не импортирует: это точка входа. Контракт моста — в src/shared.',
};
const RENDERER: Restriction = {
  regex: layerRegex('renderer'),
  message: 'src/renderer никто не импортирует: это интерфейс. Общее — в src/shared.',
};
const LOCALES: Restriction = {
  regex: layerRegex('locales', '@locales'),
  message: 'Строки локалей нужны только интерфейсу и main (диалоги). Ядро отдаёт данные, не текст.',
};
const TEST: Restriction = {
  regex: String.raw`^(\.\./)+(.*/)?test/.*$`,
  message: 'Продуктовый код не импортирует из test/. Из test/ могут брать только файлы *.test.*.',
};

const TEST_FILES = ['**/*.test.ts', '**/*.test.tsx'];

// Глобальные механизмы ослабления TLS запрещены по всему src/ (план M0, KTD-20). M1 откроет
// исключение ровно для одного файла транспорта сканера.
const TLS_MESSAGE =
  'Проверка TLS ослабляется только выделенным агентом профиля сканера, глобально — никогда.';
const TLS_NAMES =
  'rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|setCertificateVerifyProc|checkServerIdentity';
// Событие Electron и ключи командной строки Chromium, выключающие проверку сертификатов.
const TLS_STRINGS = `${TLS_NAMES}|certificate-error|ignore-certificate-errors|allow-insecure-localhost`;

interface SyntaxRestriction {
  readonly selector: string;
  readonly message: string;
}

const TLS_SELECTORS: readonly SyntaxRestriction[] = [
  { selector: `Identifier[name=/^(${TLS_NAMES})$/]`, message: TLS_MESSAGE },
  { selector: `Literal[value=/${TLS_STRINGS}/]`, message: TLS_MESSAGE },
  { selector: `TemplateElement[value.cooked=/${TLS_STRINGS}/]`, message: TLS_MESSAGE },
];

// `no-restricted-imports` видит только статические import и export-from. Динамический
// `import()` и `require()` закрываются селекторами по тому же регулярному выражению. В грамматике
// селекторов внутри `/…/` слэш недопустим даже экранированным — он записывается hex-кодом.
const SLASH_AS_HEX = String.fromCharCode(92) + 'x2f';
const dynamicImportSelectors = (restrictions: readonly Restriction[]): SyntaxRestriction[] =>
  restrictions.flatMap(({ regex, message }) => {
    const pattern = regex.replaceAll('/', SLASH_AS_HEX);
    return [
      { selector: `ImportExpression > Literal[value=/${pattern}/]`, message },
      { selector: `CallExpression[callee.name='require'] > Literal[value=/${pattern}/]`, message },
    ];
  });

function layer(dir: string, forbidden: readonly Restriction[]): Linter.Config[] {
  // Flat config не сливает опции правила между блоками, а `no-restricted-syntax` нужен и границам,
  // и запрету TLS — поэтому каждый блок слоя несёт оба набора селекторов.
  const rule = (restrictions: readonly Restriction[]): Linter.RulesRecord => ({
    'no-restricted-imports': ['error', { patterns: [...restrictions] }],
    'no-restricted-syntax': ['error', ...TLS_SELECTORS, ...dynamicImportSelectors(restrictions)],
  });

  return [
    { name: `duplexnt/layer/${dir}`, files: [`src/${dir}/**`], rules: rule([...forbidden, TEST]) },
    // Исключение для тестов открывает только test/, но не границы слоя.
    {
      name: `duplexnt/layer/${dir}/tests`,
      files: TEST_FILES.map((glob) => `src/${dir}/${glob}`),
      rules: rule(forbidden),
    },
  ];
}

export const layerBoundaryConfigs: Linter.Config[] = [
  // Страховка для файла под src/, не попавшего ни в один слой. Стоит ПЕРВОЙ: блоки слоёв ниже
  // переопределяют `no-restricted-syntax` своим, более полным набором.
  {
    name: 'duplexnt/tls-global-relaxation',
    files: ['src/**'],
    rules: { 'no-restricted-syntax': ['error', ...TLS_SELECTORS] },
  },
  ...layer('shared', [ELECTRON, NODE, CORE, MAIN, PRELOAD, RENDERER, LOCALES]),
  ...layer('core', [ELECTRON, MAIN, PRELOAD, RENDERER, LOCALES]),
  ...layer('main', [PRELOAD, RENDERER]),
  ...layer('preload', [NODE, CORE, MAIN, RENDERER, LOCALES]),
  ...layer('renderer', [ELECTRON, NODE, CORE, MAIN, PRELOAD]),
];

// ---------------------------------------------------------------------------------------------

const TS_FILES = ['**/*.ts', '**/*.tsx'];

export default defineConfig(
  {
    name: 'duplexnt/ignores',
    ignores: [
      'out/',
      'dist/',
      'release/',
      'node_modules/',
      'docs/',
      'temp/',
      'local-test-data/',
      // Одноразовый код спайка — вне сборки и вне типизированного линта.
      'spikes/',
    ],
  },
  js.configs.recommended,
  {
    name: 'duplexnt/typescript',
    files: TS_FILES,
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        // Проекты перечислены поимённо, от строгого к широкому: по `references` линтер не
        // ходит, а файл из нескольких проектов берётся из первого совпавшего.
        project: [
          './tsconfig.shared.json',
          './tsconfig.core.json',
          './tsconfig.node.json',
          './tsconfig.web.json',
          './tsconfig.test.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Числа в шаблонных строках — норма для сообщений; остальное по-прежнему под запретом.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    name: 'duplexnt/react-hooks',
    files: ['src/renderer/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
  },
  ...layerBoundaryConfigs,
);
