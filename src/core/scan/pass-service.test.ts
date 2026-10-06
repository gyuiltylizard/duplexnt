import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { fail } from '@shared';
import { describe, expect, it } from 'vitest';
import { ET_3850, readFixture } from '../../../test/support/fixtures';
import { fsError, interceptFs } from '../../../test/support/intercept-fs';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import { parseCapabilities } from '../escl/capabilities';
import type { ConnectedScanner, ConnectorOptions } from '../escl/connect';
import { scanOptionsOf } from '../escl/scan-settings';
import { layoutOf } from '../storage/layout';
import { realStorageFs, StorageError } from '../storage/storage-fs';
import { interruptionError, openPassService } from './pass-service';

// Чистые части службы прохода (план M1, U17): перевод причины обрыва в код, снимок без сканера,
// проверка параметров против вариантов устройства; политика второго прохода (M2, U3) — на
// сессиях, посеянных на диск, с подставным транспортом. Сам проход идёт против эмулятора —
// test/integration/pass.emulator.test.ts и two-pass.emulator.test.ts.

function connected(): ConnectedScanner {
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

describe('interruptionError: причина обрыва — кодом', () => {
  it('отказ устройства — как есть', () => {
    const error = { code: 'scanFeedFailed', details: { reason: 'gone' } } as const;
    expect(interruptionError({ kind: 'interrupted', reason: { source: 'device', error } })).toEqual(
      error,
    );
  });

  it('отказ приёмника — через перевод ошибок хранилища', () => {
    const storage = new StorageError({ code: 'storageFull' });
    expect(
      interruptionError({ kind: 'interrupted', reason: { source: 'sink', error: storage } }),
    ).toEqual({ code: 'storageFull' });
    expect(
      interruptionError({
        kind: 'interrupted',
        reason: { source: 'sink', error: Object.assign(new Error('x'), { code: 'EPERM' }) },
      }),
    ).toEqual({ code: 'storageFailed', details: { reason: 'EPERM' } });
  });

  it('у остальных исходов причины нет', () => {
    expect(interruptionError({ kind: 'completed' })).toBeNull();
    expect(interruptionError({ kind: 'empty' })).toBeNull();
    expect(interruptionError({ kind: 'canceled' })).toBeNull();
  });
});

describe('служба прохода без сканера', () => {
  it('снимок пустого корня: сканера нет, сессии нет, хранилище в порядке', async () => {
    const service = await openPassService(await makeTempDataRoot());

    expect(service.snapshot()).toEqual({
      seq: 0,
      scanner: { kind: 'none' },
      session: null,
      assembly: null,
      pass: null,
      canResume: false,
      canAccept: false,
      storage: { incompatible: false, unsaved: false },
      notices: [],
    });
  });

  it('без сканера проход, параметры и «Остановить» отклоняются кодом', async () => {
    const service = await openPassService(await makeTempDataRoot());

    expect(await service.startPass()).toEqual({
      ok: false,
      error: { code: 'scannerNotConnected' },
    });
    expect(
      await service.setParams({ colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' }),
    ).toEqual({ ok: false, error: { code: 'scannerNotConnected' } });
    expect(await service.stopPass()).toEqual({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'noRunningPass' } },
    });
    expect(await service.acceptPass()).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict' },
    });
    expect(await service.closeSession()).toEqual({ ok: true, value: undefined });
  });

  it('проверка запомненного сканера без запомненного — состояние «нет»', async () => {
    const seen: number[] = [];
    const service = await openPassService(await makeTempDataRoot(), {
      onChange: (seq) => seen.push(seq),
    });

    await service.checkRememberedScanner();

    expect(service.snapshot().scanner).toEqual({ kind: 'none' });
    expect(seen).toEqual([]);
  });
});

describe('служба прохода: сканер и параметры', () => {
  it('подключённый сканер виден в снимке с вариантами и параметрами по умолчанию', async () => {
    const seen: number[] = [];
    const service = await openPassService(await makeTempDataRoot(), {
      onChange: (seq) => seen.push(seq),
    });

    const scanner = connected();
    expect(await service.useScanner(scanner)).toEqual({ ok: true, value: undefined });

    expect(service.snapshot().scanner).toEqual({
      kind: 'ready',
      scanner: {
        name: scanner.capabilities.makeAndModel,
        scheme: 'https',
        host: '127.0.0.1',
        port: 9443,
      },
      options: {
        colorModes: ['Grayscale8', 'RGB24'],
        resolutions: [100, 200, 300, 600],
        paperSizes: ['A4', 'Letter'],
      },
      params: { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' },
    });
    expect(seen).toEqual([1]);
  });

  it('параметр, которого у устройства нет, отклоняется с именем поля', async () => {
    const service = await openPassService(await makeTempDataRoot());
    await service.useScanner(connected());

    expect(
      await service.setParams({ colorMode: 'RGB24', resolution: 600, paperSize: 'Letter' }),
    ).toEqual({ ok: true, value: undefined });
    expect(
      await service.setParams({ colorMode: 'BlackAndWhite1', resolution: 300, paperSize: 'A4' }),
    ).toEqual({
      ok: false,
      error: { code: 'scanParamsUnsupported', details: { field: 'colorMode' } },
    });
    expect(
      await service.setParams({ colorMode: 'RGB24', resolution: 1200, paperSize: 'A4' }),
    ).toEqual({
      ok: false,
      error: { code: 'scanParamsUnsupported', details: { field: 'resolution' } },
    });
    const { scanner } = service.snapshot();
    expect(scanner.kind === 'ready' ? scanner.params : null).toEqual({
      colorMode: 'RGB24',
      resolution: 600,
      paperSize: 'Letter',
    });
  });

  it('параметры и сканер переживают перезапуск: запомненное сверяется с вариантами', async () => {
    const root = await makeTempDataRoot();
    const service = await openPassService(root);
    await service.useScanner(connected());
    await service.setParams({ colorMode: 'RGB24', resolution: 600, paperSize: 'Letter' });

    const again = await openPassService(root);
    await again.useScanner(connected());

    const { scanner } = again.snapshot();
    expect(scanner.kind === 'ready' ? scanner.params : null).toEqual({
      colorMode: 'RGB24',
      resolution: 600,
      paperSize: 'Letter',
    });
  });
});

// --- Политика второго прохода (M2, U3) ------------------------------------------------------

const SESSION = 'a1b2c3d4e5f60718';
const pageBytes = Uint8Array.of(0xff, 0xd8, 1, 0xff, 0xd9);

interface SeededPass {
  readonly number: number;
  readonly pages: number;
  readonly state?: 'completed' | 'interrupted';
  readonly accepted?: boolean;
  readonly rotate180?: boolean;
  /** Номера фикстур-страниц устройства как содержимое; нет — байты-заглушки. */
  readonly fixtures?: readonly number[];
}

/** Сессия на диске: журнал v2 + файлы страниц; `origin: null` — политика сканер не сверяет. */
async function seedSession(
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

/** Транспорт, отвечающий отказом сети: дошли до него — политика проход пропустила. */
function refusingConnector() {
  const requests: string[] = [];
  const connector: ConnectorOptions = {
    createTransport: () => ({
      request: (options) => {
        requests.push(options.path);
        return Promise.resolve(fail('scannerUnreachable', { reason: 'refused' }));
      },
      stream: () => Promise.resolve(fail('scannerUnreachable', { reason: 'refused' })),
      close: () => undefined,
    }),
  };
  return { requests, connector };
}

async function serviceOver(root: string, connector: ConnectorOptions) {
  const service = await openPassService(root, { connector });
  await service.useScanner(connected());
  return service;
}

describe('служба прохода: политика второго прохода (M2, U3)', () => {
  it('поверх завершённого лицевого новый проход допускается: отказ приходит от сети, не политики', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [{ number: 1, pages: 3 }]);
    const { requests, connector } = refusingConnector();
    const service = await serviceOver(root, connector);

    expect(await service.startPass()).toEqual({
      ok: false,
      error: { code: 'scannerUnreachable', details: { reason: 'refused' } },
    });
    expect(requests.length).toBeGreaterThan(0);
  });

  it('поверх принятого-как-есть лицевого — то же самое', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [{ number: 1, pages: 2, state: 'interrupted', accepted: true }]);
    const service = await serviceOver(root, refusingConnector().connector);

    const result = await service.startPass();
    expect(result).toMatchObject({ ok: false, error: { code: 'scannerUnreachable' } });
  });

  it('после отказа от оборотов новый проход не начинается — до сети', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [{ number: 1, pages: 3 }], { backsDeclined: true });
    const { requests, connector } = refusingConnector();
    const service = await serviceOver(root, connector);

    expect(await service.startPass()).toEqual({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'backsDeclined' } },
    });
    expect(requests).toEqual([]);
  });

  it('при двух уцелевших проходах третий не начинается — до сети', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [
      { number: 1, pages: 3 },
      { number: 2, pages: 3 },
    ]);
    const { requests, connector } = refusingConnector();
    const service = await serviceOver(root, connector);

    expect(await service.startPass()).toEqual({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'backsPresent' } },
    });
    expect(requests).toEqual([]);
  });

  it('прерванный непринятый проход — только досканирование: политика нового прохода не включается', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [{ number: 1, pages: 3, state: 'interrupted' }]);
    const service = await serviceOver(root, refusingConnector().connector);

    // `origin: null` — пересобранный журнал: досканировать нельзя, и это НЕ путь к новому проходу.
    expect(await service.startPass()).toEqual({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'paramsUnknown' } },
    });
  });
});

describe('служба прохода: команды оборотов (M2, U3)', () => {
  it('declineBacks идемпотентен, durable и виден в снимке и сборке', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [{ number: 1, pages: 2 }]);
    const seen: number[] = [];
    const service = await openPassService(root, { onChange: (seq) => seen.push(seq) });

    expect(await service.declineBacks()).toEqual({ ok: true, value: undefined });
    expect(await service.declineBacks()).toEqual({ ok: true, value: undefined });

    expect(service.snapshot().session?.backsDeclined).toBe(true);
    expect(service.snapshot().assembly?.report).toMatchObject({
      backsDeclined: true,
      mismatch: false,
    });
    expect(seen.length).toBeGreaterThan(0);

    // Переживает перезапуск (KTD-6): снимок новой службы — не `flip`-состояние.
    const again = await openPassService(root);
    expect(again.snapshot().session?.backsDeclined).toBe(true);
  });

  it('setRotateBacks ставит флаг на проход в роли оборотов — №3 после остановки, не №1', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [
      { number: 1, pages: 2 },
      { number: 3, pages: 2 },
    ]);
    const service = await openPassService(root);

    expect(await service.setRotateBacks(true)).toEqual({ ok: true, value: undefined });

    const session = service.snapshot().session;
    expect(session?.passes.map((pass) => [pass.number, pass.rotate180])).toEqual([
      [1, false],
      [3, true],
    ]);
    const order = service.snapshot().assembly?.order ?? [];
    expect(order.filter((page) => page.side === 'back').every((page) => page.angle === 180)).toBe(
      true,
    );
  });

  it('setRotateBacks без прохода оборотов — noBacksPass', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [{ number: 1, pages: 2 }]);
    const service = await openPassService(root);

    expect(await service.setRotateBacks(true)).toEqual({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'noBacksPass' } },
    });
  });

  it('снимок несёт сборку: пары и несовпадение из посеянной сессии', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [
      { number: 1, pages: 3 },
      { number: 2, pages: 2 },
    ]);
    const service = await openPassService(root);

    expect(service.snapshot().assembly?.report).toMatchObject({
      fronts: 3,
      backs: 2,
      pairs: 2,
      unpairedSheets: [1],
      mismatch: true,
    });
  });
});

describe('служба прохода: сохранение PDF (M2, U6)', () => {
  /** Двусторонняя сессия 2+2 с настоящими JPEG устройства; обороты с флагом поворота. */
  async function savable(root: string) {
    await seedSession(root, [
      { number: 1, pages: 2, fixtures: [1, 2] },
      { number: 2, pages: 2, rotate180: true, fixtures: [6, 5] },
    ]);
  }

  async function saveTarget(root: string): Promise<string> {
    const out = join(root, 'выход');
    await mkdir(out, { recursive: true });
    return join(out, 'скан.pdf');
  }

  it('сохранение: PDF в собранном порядке, /Rotate на оборотах, отметка в журнале', async () => {
    const root = await makeTempDataRoot();
    await savable(root);
    const target = await saveTarget(root);
    const service = await openPassService(root);

    const report = await service.savePdf(() => Promise.resolve(target));

    expect(report).toEqual({
      ok: true,
      value: { canceled: false, fileName: 'скан.pdf', directory: join(root, 'выход') },
    });
    const document = await PDFDocument.load(await readFile(target));
    // Порядок: 1л, 1о, 2л, 2о; обороты повёрнуты.
    expect(document.getPageCount()).toBe(4);
    expect(document.getPages().map((page) => page.getRotation().angle)).toEqual([0, 180, 0, 180]);

    // Отметка о сохранении — durable; сессия не удалена (R12).
    expect(service.snapshot().session?.saved).toBe(true);
    const again = await openPassService(root);
    expect(again.snapshot().session?.saved).toBe(true);
    expect(again.snapshot().session?.passes).toHaveLength(2);

    // Правка после сохранения снимает отметку (KTD-7, AE12).
    expect(await again.setRotateBacks(false)).toMatchObject({ ok: true });
    expect(again.snapshot().session?.saved).toBe(false);
  });

  it('отказ в диалоге: ничего не записано, без ошибки, отметки нет', async () => {
    const root = await makeTempDataRoot();
    await savable(root);
    const target = await saveTarget(root);
    const service = await openPassService(root);

    expect(await service.savePdf(() => Promise.resolve(null))).toEqual({
      ok: true,
      value: { canceled: true },
    });
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(service.snapshot().session?.saved).toBe(false);
  });

  it('потерянная страница — отказ кодом, а не PDF без неё', async () => {
    const root = await makeTempDataRoot();
    await savable(root);
    const target = await saveTarget(root);
    await rm(join(layoutOf(root).pagesDir, 'p01-s01-0002.jpg'));
    const service = await openPassService(root);

    expect(await service.savePdf(() => Promise.resolve(target))).toMatchObject({
      ok: false,
      error: { code: 'pageUnavailable', details: { reason: 'lost' } },
    });
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('AE10: сбой на переименовании — старый файл цел, сессия цела, повтор проходит', async () => {
    const root = await makeTempDataRoot();
    await savable(root);
    const target = await saveTarget(root);
    await writeFile(target, 'прежний документ');
    let failRename = true;
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (failRename && call.op === 'rename' && call.to === target) {
        throw fsError('EACCES');
      }
    });
    const service = await openPassService(root, { fs, retry: { ceilingMs: 0 } });

    expect(await service.savePdf(() => Promise.resolve(target))).toEqual(
      fail('saveWriteFailed', { reason: 'EACCES' }),
    );
    expect(await readFile(target, 'utf8')).toBe('прежний документ');
    expect(service.snapshot().session?.saved).toBe(false);
    expect(service.snapshot().session?.passes).toHaveLength(2);

    // Повторное сохранение перезаписывает атомарно.
    failRename = false;
    expect(await service.savePdf(() => Promise.resolve(target))).toMatchObject({ ok: true });
    const document = await PDFDocument.load(await readFile(target));
    expect(document.getPageCount()).toBe(4);
    expect(service.snapshot().session?.saved).toBe(true);
  });

  it('нет места на диске — storageFull', async () => {
    const root = await makeTempDataRoot();
    await savable(root);
    const target = await saveTarget(root);
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (call.op === 'open' && call.path.startsWith(target)) {
        throw fsError('ENOSPC');
      }
    });
    const service = await openPassService(root, { fs, retry: { ceilingMs: 0 } });

    expect(await service.savePdf(() => Promise.resolve(target))).toEqual(fail('storageFull'));
  });

  it('второе сохранение поверх идущего — конфликт, второй диалог не открывается', async () => {
    const root = await makeTempDataRoot();
    await savable(root);
    const target = await saveTarget(root);
    const service = await openPassService(root);

    let release: (path: string | null) => void = () => undefined;
    let dialogs = 0;
    const hangingDialog = (): Promise<string | null> => {
      dialogs += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    };

    const first = service.savePdf(hangingDialog);
    const second = await service.savePdf(hangingDialog);
    expect(second).toEqual(fail('sessionConflict', { reason: 'saving' }));
    expect(dialogs).toBe(1);

    release(target);
    expect(await first).toMatchObject({ ok: true, value: { canceled: false } });

    // Сохранение кончилось — следующее снова допускается.
    expect(await service.savePdf(() => Promise.resolve(null))).toEqual({
      ok: true,
      value: { canceled: true },
    });
  });

  it('состояние перепроверяется после диалога: сессия закрыта, пока он висел, — отказ', async () => {
    const root = await makeTempDataRoot();
    await savable(root);
    const target = await saveTarget(root);
    const service = await openPassService(root);

    const result = await service.savePdf(async () => {
      // «Пока диалог висел»: пользователь успел закрыть сессию «Новым сканированием».
      await service.closeSession();
      return target;
    });

    expect(result).toEqual(fail('sessionConflict', { reason: 'noSession' }));
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('без сессии — noSession; сохранение не зовёт диалог', async () => {
    const service = await openPassService(await makeTempDataRoot());
    let asked = false;

    const result = await service.savePdf(() => {
      asked = true;
      return Promise.resolve(null);
    });

    expect(result).toEqual(fail('sessionConflict', { reason: 'noSession' }));
    expect(asked).toBe(false);
  });
});
