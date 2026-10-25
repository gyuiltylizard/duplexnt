import { describe, expect, it } from 'vitest';
import { fail } from '@shared';
import { ET_3850, readFixture } from '../../../test/support/fixtures';
import {
  network,
  scriptedSearch,
  status,
  virtualClock,
  type Announcement,
  type Step,
} from '../../../test/support/uuid-search';
import { parseCapabilities } from '../escl/capabilities';
import { scanOptionsOf } from '../escl/scan-settings';
import {
  CHECK_DEADLINE_MS,
  SEARCH_THRESHOLD_MS,
  locateRemembered,
  type Located,
} from './remembered-search';
import { storedScannerOf, type StoredScanner } from './stored-scanner';

// Проверка запомненного сканера с повторным поиском по UUID (M5, U4): ход из High-Level Technical
// Design плана на виртуальном времени — сроки KTD3, выбор кандидата KTD4, условия поиска R5.
// Запись адреса и гонки с ручным подключением — scanner-slot.test.ts.

const FINGERPRINT = 'ab'.repeat(32);
const OTHER_FINGERPRINT = 'cd'.repeat(32);

const REMEMBERED: StoredScanner = (() => {
  const capabilities = parseCapabilities(readFixture(...ET_3850, 'ScannerCapabilities.xml'));
  if (!capabilities.ok) {
    throw new Error('фикстура capabilities не разобрана');
  }
  return storedScannerOf({
    profile: {
      scheme: 'https',
      host: '192.0.2.10',
      port: 443,
      basePath: '/eSCL',
      fingerprint: FINGERPRINT,
    },
    capabilities: capabilities.value,
    options: scanOptionsOf(capabilities.value),
  });
})();

const OLD = '192.0.2.10:443';
const OURS = { fingerprint: FINGERPRINT };
const at = (afterMs: number, answer: Step['answer']): Step => ({ afterMs, answer });
const hangs: Step = at(0, null);

interface Setup {
  readonly scanner?: StoredScanner;
  readonly announce?: readonly Announcement[];
  /** Внешняя отмена в этот момент виртуального времени. */
  readonly abortAt?: number;
}

async function locate(devices: Record<string, Step | readonly Step[]>, setup: Setup = {}) {
  const time = virtualClock();
  const net = network(time.clock, devices);
  const search = scriptedSearch(time.clock, setup.announce);
  const controller = new AbortController();
  if (setup.abortAt !== undefined) {
    void time.clock.sleep(setup.abortAt).then(() => {
      controller.abort();
    });
  }
  const located: Located = await time.run(
    locateRemembered(setup.scanner ?? REMEMBERED, net.connector, controller.signal, search.start),
  );
  return { located, finishedAt: time.now(), net, search };
}

const hostOf = (located: Located): string | null =>
  located.state === 'ready' ? located.connected.profile.host : null;

describe('проверка запомненного: поиск по UUID находит сканер', () => {
  it('AE1: старый адрес молчит, кандидат с тем же отпечатком — готов на новом адресе', async () => {
    const { located, finishedAt, net, search } = await locate(
      { [OLD]: hangs, '192.0.2.30:443': at(800, OURS) },
      { announce: [{ at: 2000, address: '192.0.2.30' }] },
    );

    expect(located).toMatchObject({ state: 'ready', relocated: true });
    expect(hostOf(located)).toBe('192.0.2.30');
    expect(finishedAt).toBe(2800);
    // Поиск — по UUID запомненного, начат после порога; к исходу всё закрыто.
    expect(search.starts.map((it) => it.uuid)).toEqual([REMEMBERED.uuid]);
    expect(search.ends).toEqual(['stopped']);
    expect(net.open()).toBe(0);
  });

  it('AE3: на старом адресе чужой сертификат — поиск сразу, готов на новом адресе', async () => {
    const { located, finishedAt } = await locate(
      { [OLD]: at(100, { fingerprint: OTHER_FINGERPRINT }), '192.0.2.30:443': at(800, OURS) },
      { announce: [{ at: 600, address: '192.0.2.30' }] },
    );

    expect(located).toMatchObject({ state: 'ready', relocated: true });
    expect(hostOf(located)).toBe('192.0.2.30');
    expect(finishedAt).toBe(1400);
  });

  it('кандидат появился на 7,3 с и отвечает за 0,8 с — готов до жёсткого срока', async () => {
    const { located, finishedAt } = await locate(
      { [OLD]: hangs, '192.0.2.30:443': at(800, OURS) },
      { announce: [{ at: 7300, address: '192.0.2.30' }] },
    );

    expect(located).toMatchObject({ state: 'ready', relocated: true });
    expect(finishedAt).toBe(8100);
  });

  it('кандидат отвечает 503 — не подтверждён, следующий пробуется сразу', async () => {
    const { located, net, finishedAt } = await locate(
      {
        [OLD]: hangs,
        '192.0.2.30:443': at(100, status(503)),
        '192.0.2.31:443': at(800, OURS),
      },
      {
        announce: [
          { at: 2000, address: '192.0.2.30' },
          { at: 2000, address: '192.0.2.31' },
        ],
      },
    );

    expect(hostOf(located)).toBe('192.0.2.31');
    // 503 не пережидается: одна попытка, без паузы.
    expect(net.requests).toEqual([OLD, '192.0.2.30:443', '192.0.2.31:443']);
    expect(finishedAt).toBe(2900);
  });

  it('старый адрес ответил после старта поиска — готов на старом, поиск остановлен', async () => {
    const { located, search, net } = await locate(
      { [OLD]: at(3000, OURS), '192.0.2.40:443': at(5000, null) },
      { announce: [{ at: 2000, address: '192.0.2.40' }] },
    );

    expect(located).toMatchObject({ state: 'ready', relocated: false });
    expect(hostOf(located)).toBe('192.0.2.10');
    expect(search.starts).toHaveLength(1);
    expect(search.ends).toEqual(['stopped']);
    // Проба кандидата прервана, сокеты закрыты.
    expect(net.open()).toBe(0);
  });
});

describe('проверка запомненного: выбор кандидата (KTD4)', () => {
  it('кандидат с сохранёнными адресом и портом пропускается', async () => {
    const { located, net } = await locate(
      { [OLD]: at(0, fail('scannerUnreachable', { reason: 'refused' })) },
      { announce: [{ at: 500, address: '192.0.2.10' }] },
    );

    expect(located).toMatchObject({ state: 'unreachable' });
    expect(net.requests).toEqual([OLD]);
  });

  it('два кандидата до первого выбора — первым пробуется сохранённый порт', async () => {
    const { located, net } = await locate(
      {
        [OLD]: at(0, fail('scannerUnreachable', { reason: 'refused' })),
        '192.0.2.40:8443': at(100, OURS),
        '192.0.2.30:443': at(100, OURS),
      },
      {
        announce: [
          { at: 500, address: '192.0.2.40', port: 8443 },
          { at: 500, address: '192.0.2.30' },
        ],
      },
    );

    expect(hostOf(located)).toBe('192.0.2.30');
    expect(net.requests).toEqual([OLD, '192.0.2.30:443']);
  });

  it('кандидат на сохранённом порту во время пробы другого — начатая не прерывается, он следующий', async () => {
    const { located, net, finishedAt } = await locate(
      {
        [OLD]: at(0, fail('scannerUnreachable', { reason: 'refused' })),
        '192.0.2.40:8443': at(1000, fail('scannerUnreachable', { reason: 'reset' })),
        '192.0.2.30:443': at(800, OURS),
      },
      {
        announce: [
          { at: 2000, address: '192.0.2.40', port: 8443 },
          { at: 2500, address: '192.0.2.30' },
        ],
      },
    );

    expect(hostOf(located)).toBe('192.0.2.30');
    expect(net.requests).toEqual([OLD, '192.0.2.40:8443', '192.0.2.30:443']);
    expect(finishedAt).toBe(3800);
  });
});

describe('проверка запомненного: поиск ничего не дал', () => {
  it('AE2: тот же UUID с другим сертификатом — «другое устройство» к концу срока', async () => {
    const { located, finishedAt, net } = await locate(
      { [OLD]: hangs, '192.0.2.30:443': at(800, { fingerprint: OTHER_FINGERPRINT }) },
      { announce: [{ at: 2000, address: '192.0.2.30' }] },
    );

    expect(located).toEqual({
      state: 'otherDevice',
      error: { code: 'scannerCertificateChanged' },
    });
    expect(finishedAt).toBe(CHECK_DEADLINE_MS);
    expect(net.open()).toBe(0);
  });

  it('AE5: сканер выключен, поиск пуст — «не отвечает» по таймауту к жёсткому сроку', async () => {
    const { located, finishedAt, search, net } = await locate({ [OLD]: hangs });

    // Обрыв по сроку — таймаут, а не отмена: «без изменений» — только закрытие приложения.
    expect(located).toEqual({
      state: 'unreachable',
      error: { code: 'scannerUnreachable', details: { reason: 'timeout' } },
    });
    expect(finishedAt).toBe(CHECK_DEADLINE_MS);
    expect(search.ends).toEqual(['window']);
    expect(net.open()).toBe(0);
  });

  it('проба кандидата висит на жёстком сроке — прервана, «не отвечает»', async () => {
    const { located, finishedAt, net } = await locate(
      { [OLD]: hangs, '192.0.2.30:443': hangs },
      { announce: [{ at: 2000, address: '192.0.2.30' }] },
    );

    expect(located).toMatchObject({
      state: 'unreachable',
      error: { code: 'scannerUnreachable', details: { reason: 'timeout' } },
    });
    expect(finishedAt).toBe(CHECK_DEADLINE_MS);
    expect(net.open()).toBe(0);
  });

  it('чужой UUID на старом адресе, поиск пуст — «другое устройство» без причины', async () => {
    const { located } = await locate({
      [OLD]: at(100, { fingerprint: FINGERPRINT, uuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }),
    });

    expect(located).toEqual({ state: 'otherDevice', error: null });
  });

  it('сбой поиска — исход старого адреса, без ожидания срока', async () => {
    const time = virtualClock();
    const net = network(time.clock, {
      [OLD]: at(0, fail('scannerUnreachable', { reason: 'refused' })),
    });
    const located = await time.run(
      locateRemembered(REMEMBERED, net.connector, undefined, () => ({
        done: Promise.resolve('noNetwork'),
        stop: () => undefined,
      })),
    );

    expect(located).toMatchObject({
      state: 'unreachable',
      error: { details: { reason: 'refused' } },
    });
    expect(time.now()).toBe(0);
  });
});

describe('проверка запомненного: когда поиска нет', () => {
  it('здоровый адрес отвечает за 0,8 с — готов, поиск не вызывался', async () => {
    const { located, search } = await locate({ [OLD]: at(800, OURS) });

    expect(located).toMatchObject({ state: 'ready', relocated: false });
    expect(search.starts).toEqual([]);
  });

  it('AE6: старый адрес 503 в 0,1 с, 200 в 2,1 с — готов, поиск не вызывался', async () => {
    const { located, search, finishedAt } = await locate({
      [OLD]: [at(100, status(503)), at(1000, OURS)],
    });

    expect(located).toMatchObject({ state: 'ready', relocated: false });
    expect(finishedAt).toBe(2100);
    expect(finishedAt).toBeGreaterThan(SEARCH_THRESHOLD_MS);
    expect(search.starts).toEqual([]);
  });

  it.each([
    ['500 — сбой нашего сканера', at(100, status(500)), 'notEsclScanner'],
    [
      'ответ не разобран',
      at(100, fail('scannerBadResponse', { reason: 'tooLarge' })),
      'scannerBadResponse',
    ],
    ['занят до потолка', at(100, status(503)), 'scannerBusy'],
  ] as const)('%s — «не отвечает», поиск не вызывался', async (_title, step, code) => {
    const { located, search } = await locate({ [OLD]: step });

    expect(located).toMatchObject({ state: 'unreachable', error: { code } });
    expect(search.starts).toEqual([]);
  });

  it.each([
    ['профиль HTTP', { scheme: 'http', fingerprint: null }],
    ['без UUID', { uuid: null }],
    ['без отпечатка', { fingerprint: null }],
    ['адрес — имя', { host: 'scanner.local' }],
  ] as const)('AE7: %s молчит — «не отвечает», поиск не вызывался', async (_title, change) => {
    const scanner = { ...REMEMBERED, ...change };
    const key = `${scanner.host}:${String(scanner.port)}`;
    const { located, search } = await locate(
      { [key]: at(0, fail('scannerUnreachable', { reason: 'timeout' })) },
      { scanner, announce: [{ at: 0, address: '192.0.2.30' }] },
    );

    expect(located).toMatchObject({ state: 'unreachable' });
    expect(search.starts).toEqual([]);
  });

  it('внешняя отмена во время поиска — поиск остановлен, исход «отменено»', async () => {
    const { located, search, net, finishedAt } = await locate(
      { [OLD]: hangs, '192.0.2.30:443': hangs },
      { announce: [{ at: 2000, address: '192.0.2.30' }], abortAt: 3000 },
    );

    expect(located).toEqual({ state: 'unreachable', error: { code: 'canceled' } });
    expect(finishedAt).toBe(3000);
    expect(search.ends).toEqual(['canceled']);
    expect(net.open()).toBe(0);
  });
});
