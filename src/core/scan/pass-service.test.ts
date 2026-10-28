import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { EMPTY_EDITS, fail, type SessionEdits, type Snapshot } from '@shared';
import { describe, expect, it } from 'vitest';
import { ET_3850, readFixture } from '../../../test/support/fixtures';
import { fsError, interceptFs } from '../../../test/support/intercept-fs';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import { parseCapabilities } from '../escl/capabilities';
import type { ConnectedScanner, ConnectorOptions } from '../escl/connect';
import { scanOptionsOf } from '../escl/scan-settings';
import { layoutOf } from '../storage/layout';
import { openSettingsStore } from '../storage/settings-store';
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
      blankMode: 'hide',
      straightenMode: 'auto',
      seenHints: [],
    });
  });

  it('без сканера проход, параметры и «Остановить» отклоняются кодом', async () => {
    const service = await openPassService(await makeTempDataRoot());

    expect(await service.startPass(null)).toEqual({
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

/** Транспорт, который держит первый запрос до `release`: снимок идущего прохода виден снаружи. */
function gatedConnector() {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const connector: ConnectorOptions = {
    createTransport: () => ({
      request: async () => {
        await gate;
        return fail('scannerUnreachable', { reason: 'refused' });
      },
      stream: () => Promise.resolve(fail('scannerUnreachable', { reason: 'refused' })),
      close: () => undefined,
    }),
  };
  return { connector, release };
}

async function serviceOver(root: string, connector: ConnectorOptions) {
  const service = await openPassService(root, { connector });
  await service.useScanner(connected());
  return service;
}

describe('служба прохода: добавленный набор (M3.5, U3; KTD-5)', () => {
  const ADDED = { kind: 'added', after: null } as const;
  const twoPasses = [
    { number: 1, pages: 3 },
    { number: 2, pages: 3 },
  ] as const;

  it.each([
    ['при лицевых и оборотах', [...twoPasses], {}],
    ['при отказе от оборотов', [{ number: 1, pages: 3 }], { backsDeclined: true }],
    [
      'при принятом как есть лицевом',
      [{ number: 1, pages: 2, state: 'interrupted', accepted: true }],
      {},
    ],
  ] as const)(
    '%s добавленный набор допускается: отказ приходит от сети',
    async (_name, passes, extra) => {
      const root = await makeTempDataRoot();
      await seedSession(root, passes, extra);
      const { requests, connector } = refusingConnector();
      const service = await serviceOver(root, connector);

      expect(await service.startPass(ADDED)).toEqual({
        ok: false,
        error: { code: 'scannerUnreachable', details: { reason: 'refused' } },
      });
      expect(requests.length).toBeGreaterThan(0);
    },
  );

  it('снимок идущего добавленного прохода: роль added, счётчик без «из M», не досканирование', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [...twoPasses]);
    const { connector, release } = gatedConnector();
    const service = await serviceOver(root, connector);

    const pass = service.startPass({ kind: 'added', after: 'p01-s01-0002' });
    expect(service.snapshot().pass).toMatchObject({
      kind: 'added',
      expected: null,
      resumed: false,
    });
    // Второй запуск поверх идущего — passRunning, как и прежде.
    expect(await service.startPass(ADDED)).toEqual(
      fail('sessionConflict', { reason: 'passRunning' }),
    );
    release();
    await pass;
    expect(service.snapshot().pass).toBeNull();
  });

  it('без сессии добавлять не к чему — noSession, сеть не трогается', async () => {
    const root = await makeTempDataRoot();
    const { requests, connector } = refusingConnector();
    const service = await serviceOver(root, connector);

    expect(await service.startPass(ADDED)).toEqual(
      fail('sessionConflict', { reason: 'noSession' }),
    );
    // Без намерения проход начинается: отказ от сети.
    expect(await service.startPass(null)).toMatchObject({
      ok: false,
      error: { code: 'scannerUnreachable' },
    });
    expect(requests.length).toBeGreaterThan(0);
  });

  it('последний проход прерван — passInterrupted до сети; досканирование и «оставить как есть» прежние', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [
      { number: 1, pages: 3 },
      { number: 2, pages: 1, state: 'interrupted' },
    ]);
    const { requests, connector } = refusingConnector();
    const service = await serviceOver(root, connector);

    expect(await service.startPass(ADDED)).toEqual(
      fail('sessionConflict', { reason: 'passInterrupted' }),
    );
    expect(requests).toEqual([]);
    expect(service.snapshot().canAccept).toBe(true);
    // Без намерения — путь досканирования: пересобранный журнал даёт paramsUnknown, не новый проход.
    expect(await service.startPass(null)).toEqual(
      fail('sessionConflict', { reason: 'paramsUnknown' }),
    );
    expect(await service.acceptPass()).toMatchObject({ ok: true });
    expect(await service.startPass(ADDED)).toMatchObject({
      ok: false,
      error: { code: 'scannerUnreachable' },
    });
  });

  it('якорь не из сессии — invalidInput до сети; `after: null` проходит', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [...twoPasses]);
    const { requests, connector } = refusingConnector();
    const service = await serviceOver(root, connector);

    expect(await service.startPass({ kind: 'added', after: 'p01-s01-0009' })).toEqual(
      fail('invalidInput', { field: 'after' }),
    );
    expect(await service.startPass({ kind: 'added', after: 'p03-s01-0001' })).toEqual(
      fail('invalidInput', { field: 'after' }),
    );
    expect(requests).toEqual([]);
    expect(await service.startPass({ kind: 'added', after: 'p02-s01-0003' })).toMatchObject({
      ok: false,
      error: { code: 'scannerUnreachable' },
    });
    expect(requests.length).toBeGreaterThan(0);
  });

  it('без сканера добавленный набор отклоняется тем же кодом, что и обычный проход', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [...twoPasses]);
    const service = await openPassService(root);

    expect(await service.startPass(ADDED)).toEqual({
      ok: false,
      error: { code: 'scannerNotConnected' },
    });
  });
});

describe('служба прохода: политика второго прохода (M2, U3)', () => {
  it('поверх завершённого лицевого новый проход допускается: отказ приходит от сети, не политики', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [{ number: 1, pages: 3 }]);
    const { requests, connector } = refusingConnector();
    const service = await serviceOver(root, connector);

    expect(await service.startPass(null)).toEqual({
      ok: false,
      error: { code: 'scannerUnreachable', details: { reason: 'refused' } },
    });
    expect(requests.length).toBeGreaterThan(0);
  });

  it('поверх принятого-как-есть лицевого — то же самое', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [{ number: 1, pages: 2, state: 'interrupted', accepted: true }]);
    const service = await serviceOver(root, refusingConnector().connector);

    const result = await service.startPass(null);
    expect(result).toMatchObject({ ok: false, error: { code: 'scannerUnreachable' } });
  });

  it('после отказа от оборотов новый проход не начинается — до сети', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [{ number: 1, pages: 3 }], { backsDeclined: true });
    const { requests, connector } = refusingConnector();
    const service = await serviceOver(root, connector);

    expect(await service.startPass(null)).toEqual({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'backsDeclined' } },
    });
    expect(requests).toEqual([]);
  });

  it('при лицевых и оборотах третий проход без намерения не начинается — до сети', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [
      { number: 1, pages: 3 },
      { number: 2, pages: 3 },
    ]);
    const { requests, connector } = refusingConnector();
    const service = await serviceOver(root, connector);

    expect(await service.startPass(null)).toEqual({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'backsPresent' } },
    });
    expect(requests).toEqual([]);
  });

  it('снимок идущего прохода оборотов: роль backs и «из M» по лицевым (M3.5, R2)', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [{ number: 1, pages: 3 }]);
    const { connector, release } = gatedConnector();
    const service = await serviceOver(root, connector);

    const pass = service.startPass(null);
    expect(service.snapshot().pass).toMatchObject({ kind: 'backs', expected: 3, resumed: false });
    release();
    await pass;
  });

  it('прерванный непринятый проход — только досканирование: политика нового прохода не включается', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [{ number: 1, pages: 3, state: 'interrupted' }]);
    const service = await serviceOver(root, refusingConnector().connector);

    // `origin: null` — пересобранный журнал: досканировать нельзя, и это НЕ путь к новому проходу.
    expect(await service.startPass(null)).toEqual({
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

  it('тумблер 180° через setEdits ставит флаг на проход в роли оборотов — №3 после остановки, не №1', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [
      { number: 1, pages: 2 },
      { number: 3, pages: 2 },
    ]);
    const service = await openPassService(root);

    expect(await service.setEdits(EMPTY_EDITS, { 3: true })).toEqual({
      ok: true,
      value: { seq: service.snapshot().seq },
    });

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

  it('тумблер 180° без прохода оборотов — noBacksPass', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [{ number: 1, pages: 2 }]);
    const service = await openPassService(root);

    expect(await service.setEdits(EMPTY_EDITS, { 2: true })).toEqual({
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
      mode: 'sets',
      fronts: 3,
      backs: 2,
      mismatch: true,
    });
  });
});

describe('служба прохода: папка сохранения (M3, приёмка)', () => {
  it('выбранная папка переживает перезапуск службы', async () => {
    const root = await makeTempDataRoot();
    const service = await openPassService(root);
    expect(service.rememberedSaveFolder()).toBeNull();

    expect(await service.rememberSaveFolder('E:\\Архив')).toEqual({ ok: true, value: undefined });

    expect((await openPassService(root)).rememberedSaveFolder()).toBe('E:\\Архив');
  });
});

describe('служба прохода: правки редактора (M3, U3)', () => {
  const EDITS: SessionEdits = {
    order: ['p02-s01-0001', 'p01-s01-0001'],
    rotations: { 'p01-s01-0002': 90 },
    deleted: ['p02-s01-0002'],
    cuts: [1],
    names: ['', 'Договор'],
    divider: null,
    notBlank: [],
    keepOriginal: [],
  };

  it('правка видна в снимке и сборке, снимает «сохранено» и переживает перезапуск службы (AE1)', async () => {
    const root = await makeTempDataRoot();
    await seedSession(
      root,
      [
        { number: 1, pages: 2 },
        { number: 2, pages: 2 },
      ],
      { saved: true },
    );
    const service = await openPassService(root);

    expect(await service.setEdits(EDITS, { 2: true })).toEqual({
      ok: true,
      value: { seq: service.snapshot().seq },
    });

    const check = (snapshot: Snapshot): void => {
      expect(snapshot.session).toMatchObject({ saved: false, edits: EDITS });
      expect(snapshot.assembly?.order.map((page) => [page.key, page.angle])).toEqual([
        ['p02-s01-0001', 180],
        ['p01-s01-0001', 0],
        ['p01-s01-0002', 90],
      ]);
      expect(snapshot.assembly?.documents.map((doc) => [doc.name, doc.count])).toEqual([
        ['', 1],
        ['Договор', 2],
      ]);
      expect(snapshot.assembly).toMatchObject({ orderEdited: true, hasEdits: true, deleted: 1 });
    };
    check(service.snapshot());
    check((await openPassService(root)).snapshot());
  });

  it('снимок отдаёт правки нормализованными: разрез перед первой позицией снят', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [{ number: 1, pages: 3 }]);
    const service = await openPassService(root);

    await service.setEdits({ ...EMPTY_EDITS, cuts: [0, 2], names: ['Пусто', 'А', 'Б'] }, {});

    expect(service.snapshot().session?.edits).toEqual({
      ...EMPTY_EDITS,
      cuts: [2],
      names: ['А', 'Б'],
    });
  });

  it('ответ несёт номер снимка с результатом — снимок уходит и когда правки совпали с журналом', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [{ number: 1, pages: 3 }]);
    const seen: number[] = [];
    const service = await openPassService(root, { onChange: (seq) => seen.push(seq) });
    const split: SessionEdits = { ...EMPTY_EDITS, cuts: [1], names: ['', ''] };

    expect(await service.setEdits(split, {})).toEqual({ ok: true, value: { seq: seen.at(-1) } });
    const first = service.snapshot().seq;
    expect(first).toBe(seen.at(-1));

    // Те же правки ещё раз: журнал не меняется, а снимок с новым номером всё равно уходит.
    expect(await service.setEdits(split, {})).toEqual({ ok: true, value: { seq: first + 1 } });
    expect(seen.at(-1)).toBe(first + 1);
  });

  it('пока идёт проход, правка отклоняется конфликтом passRunning (KTD-9)', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [{ number: 1, pages: 2 }]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connector: ConnectorOptions = {
      createTransport: () => ({
        request: async () => {
          await gate;
          return fail('scannerUnreachable', { reason: 'refused' });
        },
        stream: () => Promise.resolve(fail('scannerUnreachable', { reason: 'refused' })),
        close: () => undefined,
      }),
    };
    const service = await serviceOver(root, connector);

    const pass = service.startPass(null);
    expect(service.snapshot().pass).not.toBeNull();
    expect(await service.setEdits(EDITS, {})).toEqual(
      fail('sessionConflict', { reason: 'passRunning' }),
    );
    release();
    await pass;

    expect(service.snapshot().session?.edits).toEqual(EMPTY_EDITS);
  });
});

describe('служба прохода: пакетное сохранение (M3, U4)', () => {
  /** Пять страниц — пять документов по разрезам; настоящие JPEG устройства. */
  async function fiveDocuments(root: string, extra: Record<string, unknown> = {}) {
    await seedSession(root, [{ number: 1, pages: 5, fixtures: [1, 2, 3, 4, 5] }], extra);
    const service = await openPassService(root);
    await service.setEdits({ ...EMPTY_EDITS, cuts: [1, 2, 3, 4], names: ['', '', '', '', ''] }, {});
    return service;
  }

  async function folderIn(root: string): Promise<string> {
    const folder = join(root, 'выход');
    await mkdir(folder, { recursive: true });
    return folder;
  }

  const NAMES = ['Счёт', 'Акт', 'Договор', 'Накладная', 'Опись'];

  /** Двусторонняя сессия 2+2 с настоящими JPEG устройства; обороты с флагом поворота. */
  async function duplex(root: string) {
    await seedSession(root, [
      { number: 1, pages: 2, fixtures: [1, 2] },
      { number: 2, pages: 2, rotate180: true, fixtures: [6, 5] },
    ]);
  }

  it('PDF в собранном порядке, /Rotate на оборотах, отметка в журнале durable, сессия цела', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await duplex(root);
    const service = await openPassService(root);

    expect(
      await service.saveDocuments(folder, { mode: 'single', names: ['скан'], retry: false }),
    ).toEqual({
      ok: true,
      value: { folder, written: [{ index: 0, fileName: 'скан.pdf' }], failed: [] },
    });
    // Папка пакета — для «Открыть папку» (M3.5, KTD-9); до пакета её нет.
    expect(service.lastBatchFolder()).toBe(folder);
    const document = await PDFDocument.load(await readFile(join(folder, 'скан.pdf')));
    // Порядок: 1л, 1о, 2л, 2о; обороты повёрнуты.
    expect(document.getPageCount()).toBe(4);
    expect(document.getPages().map((page) => page.getRotation().angle)).toEqual([0, 180, 0, 180]);

    // Отметка о сохранении — durable; сессия не удалена (R12).
    expect(service.snapshot().session?.saved).toBe(true);
    const again = await openPassService(root);
    expect(again.snapshot().session?.saved).toBe(true);
    expect(again.snapshot().session?.passes).toHaveLength(2);

    // Правка после сохранения снимает отметку (KTD-7, AE12).
    expect(await again.setEdits(EMPTY_EDITS, {})).toMatchObject({ ok: true });
    expect(again.snapshot().session?.saved).toBe(false);
  });

  it('потерянная страница — сбой файла кодом, а не PDF без неё; отметки нет', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await duplex(root);
    await rm(join(layoutOf(root).pagesDir, 'p01-s01-0002.jpg'));
    const service = await openPassService(root);
    expect(service.lastBatchFolder()).toBeNull();

    expect(
      await service.saveDocuments(folder, { mode: 'single', names: ['скан'], retry: false }),
    ).toMatchObject({
      ok: true,
      value: {
        written: [],
        failed: [
          {
            index: 0,
            fileName: 'скан.pdf',
            error: { code: 'pageUnavailable', details: { reason: 'lost' } },
          },
        ],
      },
    });
    expect(await readdir(folder)).toEqual([]);
    expect(service.snapshot().session?.saved).toBe(false);
    // Пакет без единого записанного файла папку не помнит: открывать там нечего.
    expect(service.lastBatchFolder()).toBeNull();
  });

  it('без сессии — noSession; в папку ничего не пишется', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    const service = await openPassService(root);

    expect(
      await service.saveDocuments(folder, { mode: 'single', names: ['скан'], retry: false }),
    ).toEqual(fail('sessionConflict', { reason: 'noSession' }));
    expect(await readdir(folder)).toEqual([]);
  });

  it('AE7: занятое имя — суффикс, сбой четвёртого — итог «4 из 5», повтор дописывает и ставит «сохранено»', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await writeFile(join(folder, 'акт.pdf'), 'чужой документ');
    await seedSession(root, [{ number: 1, pages: 5, fixtures: [1, 2, 3, 4, 5] }]);
    let failFourth = true;
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (failFourth && call.op === 'rename' && call.to?.endsWith('Накладная.pdf') === true) {
        throw fsError('EIO');
      }
    });
    const service = await openPassService(root, { fs, retry: { ceilingMs: 0 } });
    await service.setEdits({ ...EMPTY_EDITS, cuts: [1, 2, 3, 4], names: ['', '', '', '', ''] }, {});

    const first = await service.saveDocuments(folder, {
      mode: 'separate',
      names: NAMES,
      retry: false,
    });

    expect(first).toEqual({
      ok: true,
      value: {
        folder,
        written: [
          { index: 0, fileName: 'Счёт.pdf' },
          { index: 1, fileName: 'Акт (2).pdf' },
          { index: 2, fileName: 'Договор.pdf' },
          { index: 4, fileName: 'Опись.pdf' },
        ],
        failed: [
          {
            index: 3,
            fileName: 'Накладная.pdf',
            error: { code: 'saveWriteFailed', details: { reason: 'EIO' } },
          },
        ],
      },
    });
    expect(await readFile(join(folder, 'акт.pdf'), 'utf8')).toBe('чужой документ');
    expect(service.snapshot().session?.saved).toBe(false);

    failFourth = false;
    const retry = await service.saveDocuments(join(root, 'другая папка'), {
      mode: 'separate',
      names: NAMES,
      retry: true,
    });

    // Повтор пишет только неудавшийся — и в папку пакета, не в новую.
    expect(retry).toMatchObject({ ok: true, value: { folder, failed: [] } });
    expect(retry.ok && retry.value.written.map((file) => file.fileName)).toEqual([
      'Счёт.pdf',
      'Акт (2).pdf',
      'Договор.pdf',
      'Накладная.pdf',
      'Опись.pdf',
    ]);
    expect((await readdir(folder)).sort()).toHaveLength(6);
    const document = await PDFDocument.load(await readFile(join(folder, 'Накладная.pdf')));
    expect(document.getPageCount()).toBe(1);
    expect(service.snapshot().session?.saved).toBe(true);
  });

  it('документы — отрезки ленты с правками: порядок, углы, без удалённых', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await seedSession(root, [{ number: 1, pages: 3, fixtures: [1, 2, 3] }]);
    const service = await openPassService(root);
    await service.setEdits(
      {
        order: ['p01-s01-0003', 'p01-s01-0001', 'p01-s01-0002'],
        rotations: { 'p01-s01-0001': 90 },
        deleted: ['p01-s01-0002'],
        cuts: [1],
        names: ['', ''],
        divider: null,
        notBlank: [],
        keepOriginal: [],
      },
      {},
    );

    const saved = await service.saveDocuments(folder, {
      mode: 'separate',
      names: ['Первый', 'Второй'],
      retry: false,
    });

    expect(saved).toMatchObject({ ok: true, value: { failed: [] } });
    const second = await PDFDocument.load(await readFile(join(folder, 'Второй.pdf')));
    expect(second.getPages().map((page) => page.getRotation().angle)).toEqual([90]);
    const first = await PDFDocument.load(await readFile(join(folder, 'Первый.pdf')));
    expect(first.getPageCount()).toBe(1);
  });

  it('AE12: «один файл» при границах — один PDF со всеми страницами; разрезы и имена в журнале целы', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    const service = await fiveDocuments(root);
    const edits = service.snapshot().session?.edits;

    const saved = await service.saveDocuments(folder, {
      mode: 'single',
      names: ['Всё'],
      retry: false,
    });

    expect(saved).toEqual({
      ok: true,
      value: { folder, written: [{ index: 0, fileName: 'Всё.pdf' }], failed: [] },
    });
    const document = await PDFDocument.load(await readFile(join(folder, 'Всё.pdf')));
    expect(document.getPageCount()).toBe(5);
    expect(service.snapshot().session).toMatchObject({ saved: true, edits });
  });

  it('число имён не равно числу документов — invalidInput; ничего не записано', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    const service = await fiveDocuments(root);

    expect(
      await service.saveDocuments(folder, { mode: 'separate', names: ['Один'], retry: false }),
    ).toEqual(fail('invalidInput', { field: 'names', problem: 'count' }));
    expect(await readdir(folder)).toEqual([]);
  });

  it('все страницы удалены — nothingToSave (AE10)', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [{ number: 1, pages: 2 }]);
    const service = await openPassService(root);
    await service.setEdits({ ...EMPTY_EDITS, deleted: ['p01-s01-0001', 'p01-s01-0002'] }, {});

    expect(
      await service.saveDocuments(await folderIn(root), {
        mode: 'single',
        names: ['А'],
        retry: false,
      }),
    ).toEqual(fail('sessionConflict', { reason: 'nothingToSave' }));
  });

  it('повторять нечего — noFailedFiles', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    const service = await fiveDocuments(root);
    const request = { mode: 'separate', names: NAMES, retry: true } as const;

    expect(await service.saveDocuments(folder, request)).toEqual(
      fail('sessionConflict', { reason: 'noFailedFiles' }),
    );
    await service.saveDocuments(folder, { ...request, retry: false });
    expect(await service.saveDocuments(folder, request)).toEqual(
      fail('sessionConflict', { reason: 'noFailedFiles' }),
    );
  });

  it('правка между попыткой и повтором — повтор отклонён batchStale: пакет пишется заново (R13)', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await seedSession(root, [{ number: 1, pages: 2, fixtures: [1, 2] }]);
    let failWrite = true;
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (failWrite && call.op === 'rename' && call.to?.endsWith('Б.pdf') === true) {
        throw fsError('EIO');
      }
    });
    const service = await openPassService(root, { fs, retry: { ceilingMs: 0 } });
    await service.setEdits({ ...EMPTY_EDITS, cuts: [1], names: ['', ''] }, {});
    const request = { mode: 'separate', names: ['А', 'Б'], retry: false } as const;
    expect(await service.saveDocuments(folder, request)).toMatchObject({
      ok: true,
      value: { failed: [{ index: 1 }] },
    });

    // Между попытками — правка: поворот первого документа.
    await service.setEdits(
      { ...EMPTY_EDITS, rotations: { 'p01-s01-0001': 180 }, cuts: [1], names: ['', ''] },
      {},
    );
    failWrite = false;
    expect(await service.saveDocuments(folder, { ...request, retry: true })).toEqual(
      fail('sessionConflict', { reason: 'batchStale' }),
    );
    // Дописано ничего не было: смешанного пакета на диске нет; отметки «сохранено» нет.
    expect((await readdir(folder)).sort()).toEqual(['А.pdf']);
    expect(service.snapshot().session?.saved).toBe(false);
    // Пакет забыт: следующий повтор — нечего повторять, новый пакет — по текущей ленте.
    expect(await service.saveDocuments(folder, { ...request, retry: true })).toEqual(
      fail('sessionConflict', { reason: 'noFailedFiles' }),
    );
    expect(await service.saveDocuments(folder, request)).toMatchObject({
      ok: true,
      value: { failed: [], written: [{ fileName: 'А (2).pdf' }, { fileName: 'Б.pdf' }] },
    });
    expect(service.snapshot().session?.saved).toBe(true);
  });

  it('новый пакет забывает прежний незавершённый, даже если сам упал на папке', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await seedSession(root, [{ number: 1, pages: 1, fixtures: [1] }]);
    let failWrite = true;
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (failWrite && call.op === 'rename' && call.to?.endsWith('А.pdf') === true) {
        throw fsError('EIO');
      }
    });
    const service = await openPassService(root, { fs, retry: { ceilingMs: 0 } });
    const request = { mode: 'single', names: ['А'], retry: false } as const;
    expect(await service.saveDocuments(folder, request)).toMatchObject({
      ok: true,
      value: { failed: [{ index: 0 }] },
    });

    expect(await service.saveDocuments(join(root, 'нет такой'), request)).toMatchObject({
      ok: false,
      error: { code: 'saveWriteFailed' },
    });
    failWrite = false;
    expect(await service.saveDocuments(folder, { ...request, retry: true })).toEqual(
      fail('sessionConflict', { reason: 'noFailedFiles' }),
    );
    expect(await readdir(folder)).toEqual([]);
  });

  it('пока пишется пакет, правка отклоняется конфликтом saving (KTD-9)', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await seedSession(root, [{ number: 1, pages: 1, fixtures: [1] }]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Задержка — только на папке пакета: сверка при открытии тоже читает каталоги.
    const slowFs = {
      ...realStorageFs,
      readdir: async (path: string) => {
        if (path === folder) {
          await gate;
        }
        return realStorageFs.readdir(path);
      },
    };
    const service = await openPassService(root, { fs: slowFs });

    const request = { mode: 'single', names: ['А'], retry: false } as const;
    const saving = service.saveDocuments(folder, request);
    const busy = fail('sessionConflict', { reason: 'saving' });
    expect(await service.setEdits({ ...EMPTY_EDITS, deleted: ['p01-s01-0001'] }, {})).toEqual(busy);
    // Второй пакет (двойной клик), закрытие сессии и новый проход — тоже ждут конца записи.
    expect(await service.saveDocuments(folder, request)).toEqual(busy);
    expect(await service.closeSession()).toEqual(busy);
    expect(await service.startPass(null)).toEqual(busy);
    release();
    expect(await saving).toMatchObject({ ok: true, value: { failed: [] } });
    expect(await readdir(folder)).toEqual(['А.pdf']);
    // Запись кончилась — флаг снят.
    expect(await service.saveDocuments(folder, request)).toMatchObject({ ok: true });
  });

  it('id сессии без снимка; после «Нового сканирования» повтор пакета закрытой сессии не идёт', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await seedSession(root, [{ number: 1, pages: 1, fixtures: [1] }]);
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (call.op === 'rename' && call.to?.endsWith('А.pdf') === true) {
        throw fsError('EIO');
      }
    });
    const service = await openPassService(root, { fs, retry: { ceilingMs: 0 } });
    const request = { mode: 'single', names: ['А'], retry: false } as const;
    expect(await service.saveDocuments(folder, request)).toMatchObject({
      ok: true,
      value: { failed: [{ index: 0 }] },
    });
    const closedId = service.sessionId();
    expect(closedId).toBe(service.snapshot().session?.id);

    expect(await service.closeSession()).toMatchObject({ ok: true });
    expect(await service.saveDocuments(folder, { ...request, retry: true })).toEqual(
      fail('sessionConflict', { reason: 'noSession' }),
    );
    expect(service.sessionId()).toBeNull();
  });
});

describe('служба прохода: режим выравнивания (M6, U4)', () => {
  it('в снимке — из настроек: без файла «выравнивать», записанный режим помнится между открытиями', async () => {
    const root = await makeTempDataRoot();
    expect((await openPassService(root)).snapshot().straightenMode).toBe('auto');

    expect(await (await openSettingsStore(root)).setStraightenMode('off')).toEqual({
      ok: true,
      value: undefined,
    });

    expect((await openPassService(root)).snapshot().straightenMode).toBe('off');
  });
});

describe('служба прохода: режим пустых оборотов (M4, U3)', () => {
  it('принимается без сканера, уходит в снимок и помнится между открытиями службы', async () => {
    const root = await makeTempDataRoot();
    const service = await openPassService(root);
    const seqBefore = service.snapshot().seq;

    expect(service.snapshot().blankMode).toBe('hide');
    expect(await service.setBlankMode('keep')).toEqual({ ok: true, value: undefined });
    expect(service.snapshot().blankMode).toBe('keep');
    expect(service.snapshot().seq).toBeGreaterThan(seqBefore);

    expect((await openPassService(root)).snapshot().blankMode).toBe('keep');
  });
});
