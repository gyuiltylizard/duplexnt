import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { layerBoundaryConfigs } from '../../eslint.config';

// Свой экземпляр ESLint: парсер TypeScript без типовой информации плюс только блоки границ.
// Типизированный линт синтетический файл не примет — он не входит ни в один проект.
const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: [
    { files: ['**/*.ts', '**/*.tsx'], languageOptions: { parser: tseslint.parser } },
    ...layerBoundaryConfigs,
  ],
});

async function lint(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  if (result === undefined) {
    throw new Error(`ESLint не вернул результат для ${filePath}`);
  }
  const fatal = result.messages.find((message) => message.fatal === true);
  if (fatal !== undefined) {
    throw new Error(`Синтетический файл не разобран: ${fatal.message}`);
  }
  return result.messages.map((message) => `${message.ruleId ?? '?'}: ${message.message}`);
}

describe('граница ядра', () => {
  it('AE1: импорт electron из src/core — ошибка, сообщение называет, куда класть адаптеры', async () => {
    const messages = await lint('src/core/x.ts', "import { app } from 'electron';\nvoid app;\n");

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('no-restricted-imports');
    expect(messages[0]).toContain('src/main');
  });

  it('import type из electron — тоже ошибка', async () => {
    const messages = await lint(
      'src/core/x.ts',
      "import type { App } from 'electron';\nexport type A = App;\n",
    );
    expect(messages).toHaveLength(1);
  });

  it('относительный импорт из src/main — ошибка', async () => {
    expect(await lint('src/core/probe/x.ts', "import '../../main/index';\n")).toHaveLength(1);
    expect(await lint('src/core/x.ts', "import '../main';\n")).toHaveLength(1);
  });

  it('node:https и src/shared — чисто', async () => {
    const code =
      "import 'node:https';\nimport '@shared';\nimport '@shared/bridge';\nimport '../shared/bridge';\nimport './probe/handle-probe';\n";
    expect(await lint('src/core/x.ts', code)).toEqual([]);
  });

  it('locales и test/ из ядра — ошибка', async () => {
    expect(await lint('src/core/x.ts', "import '@locales/ru/common.json';\n")).toHaveLength(1);
    expect(await lint('src/core/x.ts', "import '../../locales/ru/common.json';\n")).toHaveLength(1);
    expect(await lint('src/core/x.ts', "import '../../test/fixtures/paths';\n")).toHaveLength(1);
  });

  it('тестовый файл ядра может брать из test/, но не может electron', async () => {
    expect(await lint('src/core/x.test.ts', "import '../../test/fixtures/paths';\n")).toEqual([]);
    expect(await lint('src/core/x.test.ts', "import 'electron';\n")).toHaveLength(1);
  });

  it('соседний модуль с похожим именем не принимается за слой', async () => {
    expect(await lint('src/core/x.ts', "import './main-loop';\nimport '../core-utils';\n")).toEqual(
      [],
    );
    expect(await lint('src/main/shell/x.ts', "import './web-preferences.test';\n")).toEqual([]);
  });
});

describe('граница интерфейса и preload', () => {
  it('renderer: electron, node:fs и ядро — ошибка', async () => {
    expect(await lint('src/renderer/src/x.tsx', "import 'electron';\n")).toHaveLength(1);
    expect(await lint('src/renderer/src/x.tsx', "import 'node:fs';\n")).toHaveLength(1);
    expect(await lint('src/renderer/src/x.tsx', "import '@core';\n")).toHaveLength(1);
    expect(await lint('src/renderer/src/x.tsx', "import '../../core/index';\n")).toHaveLength(1);
  });

  it('renderer: shared, locales и react — чисто', async () => {
    const code = "import 'react';\nimport '@shared';\nimport '@locales/ru/common.json';\n";
    expect(await lint('src/renderer/src/x.tsx', code)).toEqual([]);
  });

  it('preload: electron и shared — чисто; ядро и node:* — ошибка', async () => {
    expect(await lint('src/preload/index.ts', "import 'electron';\nimport '@shared';\n")).toEqual(
      [],
    );
    expect(await lint('src/preload/index.ts', "import '@core';\n")).toHaveLength(1);
    expect(await lint('src/preload/index.ts', "import 'node:fs';\n")).toHaveLength(1);
  });
});

describe('main и shared', () => {
  it('main: electron, ядро, locales и node:* — чисто', async () => {
    const code =
      "import 'electron';\nimport '@core';\nimport '@locales/ru/common.json';\nimport 'node:path';\nimport './shell/guards';\n";
    expect(await lint('src/main/index.ts', code)).toEqual([]);
  });

  it('main: renderer и preload — ошибка', async () => {
    expect(await lint('src/main/index.ts', "import '../renderer/src/App';\n")).toHaveLength(1);
    expect(await lint('src/main/index.ts', "import '../preload/index';\n")).toHaveLength(1);
  });

  it('shared: ничего, кроме себя', async () => {
    for (const source of [
      'electron',
      'node:fs',
      '@core',
      '../main/index',
      '@locales/ru/common.json',
    ]) {
      expect(await lint('src/shared/x.ts', `import '${source}';\n`), source).toHaveLength(1);
    }
    expect(await lint('src/shared/x.ts', "import './bridge';\n")).toEqual([]);
  });
});

describe('глобальное ослабление TLS', () => {
  it('rejectUnauthorized и NODE_TLS_REJECT_UNAUTHORIZED под src/ — ошибка', async () => {
    const samples = [
      'export const options = { rejectUnauthorized: false };\n',
      "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';\n",
      "process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';\n",
      'declare const s: { setCertificateVerifyProc(f: unknown): void };\ns.setCertificateVerifyProc(null);\n',
      "declare const app: { on(n: string, f: unknown): void };\napp.on('certificate-error', null);\n",
    ];
    for (const code of samples) {
      const messages = await lint('src/core/net/x.ts', code);
      expect(messages.length, code).toBeGreaterThan(0);
      expect(messages[0]).toContain('no-restricted-syntax');
    }
  });

  it('обычный сетевой код — чисто', async () => {
    const code =
      "import { Agent } from 'node:https';\nexport const agent = new Agent({ keepAlive: true });\n";
    expect(await lint('src/core/net/x.ts', code)).toEqual([]);
  });
});
