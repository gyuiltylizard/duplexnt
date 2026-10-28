import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from '../../src/shared';
import { parseCapabilities } from '../../src/core/escl/capabilities';
import type { ConnectedScanner, ConnectorOptions } from '../../src/core/escl/connect';
import { scanOptionsOf } from '../../src/core/escl/scan-settings';
import { openPassService } from '../../src/core/scan/pass-service';
import { layoutOf } from '../../src/core/storage/layout';
import { ET_3850, readFixture } from './fixtures';
import { SESSION } from './session-store';

// Общие хелперы тестов службы прохода без сканера и эмулятора
// (`src/core/scan/pass-service*.test.ts`): подключённый сканер из фикстуры capabilities, посев
// сессии на диск, подставные транспорты. Живут здесь, а не рядом с тестами: продуктовым файлам
// src/ импорт из test/ закрыт. Тесты поделены по смыслу (правило размера тестового файла):
// `pass-service.test.ts` — причины обрыва, снимок без сканера, параметры, политика проходов,
//   добавленный набор, команды оборотов, папка, правки редактора;
// `pass-service.save.test.ts` — пакетное сохранение PDF;
// `pass-service.modes.test.ts` — режимы пустых оборотов и выравнивания из настроек;
// `pass-service.blank.test.ts`, `pass-service.pairs.test.ts`, `pass-service.assemble.test.ts` —
//   оценки пустых, пара добавленного набора, сборка ленты.
// Обвязка на эмуляторе — `pass-service.ts` рядом.

export { SESSION };
/** Байты-заглушка страницы: маркеры JPEG есть, картинки нет. */
const pageBytes = Uint8Array.of(0xff, 0xd8, 1, 0xff, 0xd9);

/** Сканер, «подключённый» по фикстуре capabilities ET-3850; сеть не трогается. */
export function connected(): ConnectedScanner {
  const capabilities = parseCapabilities(readFixture(...ET_3850, 'ScannerCapabilities.xml'));
  if (!capabilities.ok) {
    throw new Error('фикстура capabilities не разобрана');
  }
  return {
    profile: {
      scheme: 'https',
      host: '127.0.0.1',
      port: 9443,
      basePath: '/eSCL',
      fingerprint: null,
    },
    capabilities: capabilities.value,
    options: scanOptionsOf(capabilities.value),
  };
}

export interface SeededPass {
  readonly number: number;
  readonly pages: number;
  readonly state?: 'completed' | 'interrupted';
  readonly accepted?: boolean;
  readonly rotate180?: boolean;
  /** Номера фикстур-страниц устройства как содержимое; нет — байты-заглушки. */
  readonly fixtures?: readonly number[];
}

/** Сессия на диске: журнал v2 + файлы страниц; `origin: null` — политика сканер не сверяет. */
export async function seedSession(
  root: string,
  passes: readonly SeededPass[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  const layout = layoutOf(root);
  await mkdir(layout.pagesDir, { recursive: true });
  const journal = {
    version: 2,
    sessionId: SESSION,
    nextPass: Math.max(...passes.map((pass) => pass.number)) + 1,
    passes: passes.map((pass) => ({
      number: pass.number,
      accepted: pass.accepted ?? false,
      origin: null,
      nextSegment: 2,
      segments: [{ number: 1, state: pass.state ?? 'completed', pageCount: pass.pages }],
      rotate180: pass.rotate180 ?? false,
    })),
    deletions: [],
    backsDeclined: false,
    saved: false,
    ...extra,
  };
  await writeFile(layout.journalFile, JSON.stringify(journal));
  for (const pass of passes) {
    for (let index = 1; index <= pass.pages; index += 1) {
      const name = `p${String(pass.number).padStart(2, '0')}-s01-${String(index).padStart(4, '0')}.jpg`;
      const fixture = pass.fixtures?.[index - 1];
      const content =
        fixture === undefined
          ? pageBytes
          : readFixture(...ET_3850, 'pages', `page-${String(fixture).padStart(2, '0')}.jpg`);
      await writeFile(join(layout.pagesDir, name), content);
    }
  }
}

const refused = () => fail('scannerUnreachable', { reason: 'refused' });

/** Транспорт, отвечающий отказом сети на всё; `onRequest` видит каждый запрос до ответа. */
function refusingTransport(onRequest: (path: string) => Promise<void> | void): ConnectorOptions {
  return {
    createTransport: () => ({
      request: async (options) => {
        await onRequest(options.path);
        return refused();
      },
      stream: () => Promise.resolve(refused()),
      close: () => undefined,
    }),
  };
}

/** Транспорт, отвечающий отказом сети: дошли до него — политика проход пропустила. */
export function refusingConnector() {
  const requests: string[] = [];
  const connector = refusingTransport((path) => {
    requests.push(path);
  });
  return { requests, connector };
}

/** Транспорт, который держит каждый запрос до `release`: снимок идущего прохода виден снаружи. */
export function gatedConnector() {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const connector = refusingTransport(() => gate);
  return { connector, release };
}

/** Служба на корне с подставным транспортом и подключённым сканером из фикстуры. */
export async function serviceOver(root: string, connector: ConnectorOptions) {
  const service = await openPassService(root, { connector });
  await service.useScanner(connected());
  return service;
}
