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

  it('ключи Chromium, шаблонные строки и доступ по строковому ключу — тоже ошибка', async () => {
    const samples = [
      "declare const app: { commandLine: { appendSwitch(s: string): void } };\napp.commandLine.appendSwitch('ignore-certificate-errors');\n",
      "export const flag = '--ignore-certificate-errors';\n",
      "export const flag = 'allow-insecure-localhost';\n",
      'declare const app: { on(n: string, f: unknown): void };\napp.on(`certificate-error`, null);\n',
      "declare const s: Record<string, (f: unknown) => void>;\ns['setCertificateVerifyProc']?.(null);\n",
      'export const options = { checkServerIdentity: () => undefined };\n',
    ];
    for (const code of samples) {
      const messages = await lint('src/main/x.ts', code);
      expect(messages.length, code).toBeGreaterThan(0);
      expect(messages[0]).toContain('no-restricted-syntax');
    }
  });

  it('запрет действует в каждом слое — блок слоя его не затирает', async () => {
    for (const file of [
      'src/shared/x.ts',
      'src/core/x.ts',
      'src/main/x.ts',
      'src/preload/x.ts',
      'src/renderer/src/x.tsx',
      'src/core/x.test.ts',
    ]) {
      const messages = await lint(file, 'export const o = { rejectUnauthorized: false };\n');
      expect(messages, file).toHaveLength(1);
    }
  });

  it('обычный сетевой код — чисто', async () => {
    const code =
      "import { Agent } from 'node:https';\nexport const agent = new Agent({ keepAlive: true });\n";
    expect(await lint('src/core/net/x.ts', code)).toEqual([]);
  });
});

describe('исключение TLS для транспорта сканера', () => {
  const TRANSPORT = 'src/core/escl/transport.ts';
  const AGENT =
    "import { Agent } from 'node:https';\nexport const agent = new Agent({ rejectUnauthorized: false });\n";

  it('агент с ослабленной проверкой разрешён ровно в файле транспорта', async () => {
    expect(await lint(TRANSPORT, AGENT)).toEqual([]);
  });

  it('тот же код в любом другом файле src/ — ошибка', async () => {
    for (const file of [
      'src/core/escl/scan-job.ts',
      'src/core/escl/transport.test.ts',
      'src/core/escl/transport/index.ts',
      'src/core/discovery/transport.ts',
      'src/main/transport.ts',
      'src/main/index.ts',
      'src/preload/index.ts',
      'src/renderer/src/transport.ts',
    ]) {
      const messages = await lint(file, AGENT.replace("import { Agent } from 'node:https';\n", ''));
      expect(messages, file).toHaveLength(1);
      expect(messages[0], file).toContain('no-restricted-syntax');
    }
  });

  it('остальные способы ослабить TLS запрещены и в файле транспорта', async () => {
    const samples = [
      "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';\n",
      'export const options = { checkServerIdentity: () => undefined };\n',
      'declare const s: { setCertificateVerifyProc(f: unknown): void };\ns.setCertificateVerifyProc(null);\n',
      "declare const app: { on(n: string, f: unknown): void };\napp.on('certificate-error', null);\n",
      "export const flag = '--ignore-certificate-errors';\n",
    ];
    for (const code of samples) {
      const messages = await lint(TRANSPORT, code);
      expect(messages.length, code).toBeGreaterThan(0);
      expect(messages[0], code).toContain('no-restricted-syntax');
    }
  });

  it('исключение не открывает границы слоя: Electron и вышележащие слои — ошибка', async () => {
    expect(await lint(TRANSPORT, "import 'electron';\n")).toHaveLength(1);
    expect(await lint(TRANSPORT, "import '../../main/index';\n")).toHaveLength(1);
    expect(await lint(TRANSPORT, "export const e = import('electron');\n")).toHaveLength(1);
    expect(await lint(TRANSPORT, "import '../../../test/support/fixtures';\n")).toHaveLength(1);
  });
});

describe('обходы статического импорта', () => {
  it('динамический import() через границу слоя — ошибка', async () => {
    expect(
      await lint('src/core/x.ts', "export const e = await import('electron');\n"),
    ).toHaveLength(1);
    expect(
      await lint('src/renderer/src/x.tsx', "export const c = import('@core');\n"),
    ).toHaveLength(1);
    expect(
      await lint('src/renderer/src/x.tsx', "export const c = import('../../core/index');\n"),
    ).toHaveLength(1);
  });

  it('require() через границу слоя — ошибка', async () => {
    const code =
      "declare const require: (id: string) => unknown;\nexport const e = require('electron');\n";
    expect(await lint('src/core/x.ts', code)).toHaveLength(1);
  });

  it('разрешённый динамический импорт — чисто', async () => {
    expect(await lint('src/main/x.ts', "export const c = import('@core');\n")).toEqual([]);
    expect(await lint('src/core/x.ts', "export const h = import('node:https');\n")).toEqual([]);
  });

  it("голое имя встроенного модуля — то же, что 'node:'", async () => {
    expect(await lint('src/preload/index.ts', "import 'fs';\n")).toHaveLength(1);
    expect(await lint('src/renderer/src/x.tsx', "import 'fs/promises';\n")).toHaveLength(1);
    expect(await lint('src/shared/x.ts', "import 'path';\n")).toHaveLength(1);
    expect(await lint('src/main/x.ts', "import 'path';\nimport 'fs/promises';\n")).toEqual([]);
    expect(await lint('src/core/x.ts', "import 'path';\n")).toEqual([]);
  });

  it('пакет с именем, похожим на встроенный модуль, не задет', async () => {
    expect(await lint('src/renderer/src/x.tsx', "import 'react';\nimport 'fs-extra';\n")).toEqual(
      [],
    );
  });
});

describe('изоляция эмулятора сканера', () => {
  it('импорт из кода приложения — ошибка: алиасом, относительным путём и динамически', async () => {
    const samples = [
      "import '@core';\n",
      "import { parseCapabilities } from '@core/escl/capabilities';\nvoid parseCapabilities;\n",
      "import '@shared';\n",
      "import '@locales/ru/common.json';\n",
      "import '../../src/core/escl/transport';\n",
      "import type { Result } from '../../src/shared/errors';\nexport type R = Result<number>;\n",
      "export const c = import('../../src/core/index');\n",
      "export const c = import('@core');\n",
    ];
    for (const code of samples) {
      const messages = await lint('test/emulator/server.ts', code);
      expect(messages, code).toHaveLength(1);
      expect(messages[0], code).toContain('фикстуры');
    }
  });

  it('вложенный файл эмулятора и его тест — под тем же запретом', async () => {
    expect(
      await lint('test/emulator/scenarios/pass.ts', "import '../../../src/core';\n"),
    ).toHaveLength(1);
    expect(await lint('test/emulator/server.test.ts', "import '@core';\n")).toHaveLength(1);
    expect(await lint('test/emulator/cli.ts', "import 'electron';\n")).toHaveLength(1);
  });

  it('node:*, помощник фикстур и соседние модули эмулятора — чисто', async () => {
    const code =
      "import 'node:http';\nimport 'node:https';\nimport '../support/fixtures';\nimport './scenarios';\n";
    expect(await lint('test/emulator/server.ts', code)).toEqual([]);
  });

  it('каталог с src в имени за код приложения не принимается', async () => {
    expect(await lint('test/emulator/server.ts', "import '../support/src-map';\n")).toEqual([]);
  });

  it('запрет не задевает остальные тесты: интеграционные берут и ядро, и эмулятор', async () => {
    const code = "import '../../src/core/index';\nimport '../emulator/server';\n";
    expect(await lint('test/integration/scan-job.test.ts', code)).toEqual([]);
  });
});
