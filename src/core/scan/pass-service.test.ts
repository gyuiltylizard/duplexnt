import { EMPTY_EDITS, fail, type SessionEdits, type Snapshot } from '@shared';
import { describe, expect, it } from 'vitest';
import {
  connected,
  gatedConnector,
  refusingConnector,
  seedSession,
  serviceOver,
} from '../../../test/support/pass-service-seed';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import type { ConnectorOptions } from '../escl/connect';
import { StorageError } from '../storage/storage-fs';
import { interruptionError, openPassService } from './pass-service';

// Чистые части службы прохода (план M1, U17): перевод причины обрыва в код, снимок без сканера,
// проверка параметров против вариантов устройства; политика второго прохода (M2, U3) — на
// сессиях, посеянных на диск, с подставным транспортом; добавленный набор, команды оборотов,
// папка, правки редактора. Сам проход идёт против эмулятора — test/integration/pass.emulator.test.ts
// и two-pass.emulator.test.ts. Пакетное сохранение — `pass-service.save.test.ts`, режимы из
// настроек — `pass-service.modes.test.ts`; общие хелперы — test/support/pass-service-seed.ts.

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
      straightenProgress: null,
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
    expect(await service.useScanner(scanner)).toEqual({ ok: true, value: { settingsSaved: true } });

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
