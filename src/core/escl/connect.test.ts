import { describe, expect, it } from 'vitest';
import { fail, ok, type DomainError, type Result } from '@shared';
import { ET_3850, readFixture, readFixtureText } from '../../../test/support/fixtures';
import {
  createConnector,
  parseScannerAddress,
  probeScanner,
  type ProbeClock,
  type ScannerAddress,
} from './connect';
import type { BufferedResponse, ScannerProfile, ScannerTransport } from './transport';

// Разбор ввода и правила выбора схемы — на подставном транспорте. Настоящая сеть — в
// test/integration/connect.emulator.test.ts.

const address = (input: string): ScannerAddress => {
  const parsed = parseScannerAddress(input);
  if (!parsed.ok) {
    throw new Error(`адрес не разобран: ${input}`);
  }
  return parsed.value;
};

describe('разбор адреса сканера', () => {
  it('хост без схемы и порта: схема не названа, путь по умолчанию', () => {
    expect(parseScannerAddress('192.0.2.10')).toEqual(
      ok({ scheme: null, host: '192.0.2.10', port: null, basePath: '/eSCL' }),
    );
  });

  it('хост с портом', () => {
    expect(address('scanner.example:8443')).toEqual({
      scheme: null,
      host: 'scanner.example',
      port: 8443,
      basePath: '/eSCL',
    });
  });

  it('полный URL: схема, порт и путь берутся из него', () => {
    expect(address('http://192.0.2.10:8080/scan/eSCL')).toEqual({
      scheme: 'http',
      host: '192.0.2.10',
      port: 8080,
      basePath: '/scan/eSCL',
    });
    expect(address('HTTPS://Scanner.Example').scheme).toBe('https');
    expect(address('HTTPS://Scanner.Example').host).toBe('scanner.example');
  });

  it.each(['192.0.2.10', '192.0.2.10/', '192.0.2.10/eSCL', '192.0.2.10/eSCL/', '192.0.2.10//'])(
    '«%s»: /eSCL, /eSCL/ и пустой путь дают один базовый путь',
    (input) => {
      expect(address(input).basePath).toBe('/eSCL');
    },
  );

  it('пробелы по краям отбрасываются; имя с точкой на конце и подчёркиванием принимается', () => {
    expect(address('  192.0.2.10  ').host).toBe('192.0.2.10');
    expect(address('my_scanner.lan.').host).toBe('my_scanner.lan.');
  });

  it.each([
    ['', 'address'],
    ['   ', 'address'],
    ['user@192.0.2.10', 'host'],
    ['https://user:pass@192.0.2.10/eSCL', 'host'],
    ['192.0.2.10/eSCL?x=1', 'address'],
    ['192.0.2.10/eSCL#top', 'address'],
    ['192.0.2.10/eSCL/../admin', 'path'],
    ['192.0.2.10/%2e%2e/admin', 'path'],
    ['192.0.2.10\\eSCL', 'address'],
    ['192.0.2.10/eS CL', 'path'],
    ['192.0.2.10:0', 'port'],
    ['192.0.2.10:65536', 'port'],
    ['192.0.2.10:99999', 'port'],
    ['192.0.2.10:abc', 'host'],
    ['192.0.2.10:', 'host'],
    ['ftp://192.0.2.10', 'host'],
    ['[2001:db8::1]', 'host'],
    ['[2001:db8::1]:443', 'host'],
    ['-bad-.example', 'host'],
    ['two..dots', 'host'],
    ['сканер.рф', 'host'],
    [`${'a'.repeat(64)}.example`, 'host'],
    [`${'a.'.repeat(130)}example`, 'host'],
    [`192.0.2.10/${'a'.repeat(600)}`, 'path'],
    [`192.0.2.10/${'a'.repeat(1100)}`, 'address'],
  ])('«%s» — неверный вход (%s)', (input, field) => {
    expect(parseScannerAddress(input)).toEqual(fail('invalidInput', { field }));
  });
});

// ---------------------------------------------------------------------------------------------

const CAPABILITIES = readFixture(...ET_3850, 'ScannerCapabilities.xml');
const FINGERPRINT = 'ab'.repeat(32);

const reply = (status: number, body: Uint8Array = new Uint8Array()): Result<BufferedResponse> =>
  ok({ status, location: null, contentType: null, fingerprint: FINGERPRINT, body });
const unreachable = (reason: string): Result<never> => fail('scannerUnreachable', { reason });

type Answer = Result<BufferedResponse> | Promise<Result<BufferedResponse>>;

/** Фабрика транспортов по сценарию: ответ на каждую пробу — по порядку. */
function scripted(answers: readonly ((signal: AbortSignal | undefined) => Answer)[]) {
  const queue = [...answers];
  const profiles: ScannerProfile[] = [];
  const paths: string[] = [];
  let closed = 0;

  const createTransport = (profile: ScannerProfile): ScannerTransport => ({
    request: async (options) => {
      profiles.push(profile);
      paths.push(options.path);
      const answer = queue.shift();
      if (answer === undefined) {
        throw new Error('проба сверх сценария');
      }
      return answer(options.signal);
    },
    stream: () => Promise.reject(new Error('подключение страницы не запрашивает')),
    close: () => {
      closed += 1;
    },
  });
  return {
    createTransport,
    profiles,
    paths,
    closed: () => closed,
    targets: () => profiles.map((it) => `${it.scheme}:${it.port}`),
  };
}

const errorOf = (result: Result<unknown>): DomainError | null => (result.ok ? null : result.error);

describe('подключение: профиль', () => {
  it('профиль создаётся из capabilities: варианты параметров и отпечаток из ответа', async () => {
    const fake = scripted([() => reply(200, CAPABILITIES)]);

    const result = await createConnector(fake).connect(address('https://192.0.2.10'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.profile).toEqual({
        scheme: 'https',
        host: '192.0.2.10',
        port: 443,
        basePath: '/eSCL',
        fingerprint: FINGERPRINT,
      });
      expect(result.value.options).toEqual({
        colorModes: ['Grayscale8', 'RGB24'],
        resolutions: [100, 200, 300, 600],
        paperSizes: ['A4', 'Letter'],
      });
      expect(result.value.capabilities.adf.maxWidth).toBe(2550);
    }
    expect(fake.paths).toEqual(['/eSCL/ScannerCapabilities']);
    // Проба идёт без запомненного отпечатка, временный транспорт уничтожен.
    expect(fake.profiles[0]?.fingerprint).toBeNull();
    expect(fake.closed()).toBe(1);
  });

  it('базовый путь из адреса доходит до запроса', async () => {
    const fake = scripted([() => reply(200, CAPABILITIES)]);

    await createConnector(fake).connect(address('192.0.2.10/scan/eSCL'));

    expect(fake.paths).toEqual(['/scan/eSCL/ScannerCapabilities']);
  });

  // `503` — «занят», его пережидают (M5, KTD6); остальные `5xx` — по-прежнему «не сканер».
  it.each([
    [404, 'notEsclScanner'],
    [401, 'notEsclScanner'],
    [500, 'notEsclScanner'],
  ])('ответ %i вместо capabilities — %s; транспорт уничтожен', async (status, code) => {
    const fake = scripted([() => reply(status)]);

    const result = await createConnector(fake).connect(address('192.0.2.10'));

    expect(errorOf(result)).toEqual({ code, details: { status } });
    expect(fake.closed()).toBe(1);
  });

  it('страница HTML и не-XML по адресу — «не сканер eSCL», а не «испорченный ответ»', async () => {
    const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
    const pages = [
      '<!DOCTYPE html><html><body>Router</body></html>',
      'plain text',
      '<html><body><br></body></html>',
      '<?xml version="1.0"?><other xmlns="urn:x"/>',
    ];

    for (const page of pages) {
      const fake = scripted([() => reply(200, encode(page))]);
      const result = await createConnector(fake).connect(address('192.0.2.10'));
      expect(errorOf(result)?.code).toBe('notEsclScanner');
    }
  });

  it('устройство без автоподачи и устройство без JPEG отклоняются своими кодами', async () => {
    const noAdf = readFixture('escl', 'no-adf', 'ScannerCapabilities.xml');
    const text = readFixtureText(...ET_3850, 'ScannerCapabilities.xml');
    const noJpeg = new TextEncoder().encode(text.replaceAll('image/jpeg', 'image/tiff'));

    const first = await createConnector(scripted([() => reply(200, noAdf)])).connect(
      address('192.0.2.10'),
    );
    const second = await createConnector(scripted([() => reply(200, noJpeg)])).connect(
      address('192.0.2.10'),
    );

    expect(errorOf(first)).toEqual({ code: 'scannerNoAdf' });
    expect(errorOf(second)).toEqual({ code: 'scannerNoJpeg' });
  });

  it('устройство, у которого с JPEG остаётся только чёрно-белый режим, отклоняется', async () => {
    const text = readFixtureText(...ET_3850, 'ScannerCapabilities.xml');
    const onlyBlackAndWhite = new TextEncoder().encode(
      text
        .replaceAll('<scan:ColorMode>Grayscale8</scan:ColorMode>', '')
        .replaceAll('<scan:ColorMode>RGB24</scan:ColorMode>', ''),
    );

    const result = await createConnector(scripted([() => reply(200, onlyBlackAndWhite)])).connect(
      address('192.0.2.10'),
    );

    expect(errorOf(result)).toEqual({ code: 'scannerNoJpeg' });
  });

  it('автоподача, в которую не помещается ни A4, ни Letter, отклоняется', async () => {
    const text = readFixtureText(...ET_3850, 'ScannerCapabilities.xml');
    const narrow = new TextEncoder().encode(
      text.replaceAll('<scan:MaxWidth>2550</scan:MaxWidth>', '<scan:MaxWidth>1200</scan:MaxWidth>'),
    );

    const result = await createConnector(scripted([() => reply(200, narrow)])).connect(
      address('192.0.2.10'),
    );

    expect(errorOf(result)).toEqual({
      code: 'scanParamsUnsupported',
      details: { field: 'paperSize' },
    });
  });
});

describe('подключение: выбор схемы (KTD-8)', () => {
  it('схема не названа: HTTPS первым; отказ соединения — переход на HTTP, порт по умолчанию', async () => {
    const fake = scripted([() => unreachable('refused'), () => reply(200, CAPABILITIES)]);

    const result = await createConnector(fake).connect(address('192.0.2.10'));

    expect(fake.targets()).toEqual(['https:443', 'http:80']);
    expect(result.ok && result.value.profile.scheme).toBe('http');
    expect(result.ok && result.value.profile.port).toBe(80);
    expect(fake.closed()).toBe(2);
  });

  it('сбой рукопожатия — тоже переход; названный порт сохраняется', async () => {
    const fake = scripted([() => unreachable('tls'), () => reply(200, CAPABILITIES)]);

    const result = await createConnector(fake).connect(address('192.0.2.10:8080'));

    expect(fake.targets()).toEqual(['https:8080', 'http:8080']);
    expect(result.ok && result.value.profile.port).toBe(8080);
  });

  it.each(['timeout', 'dns', 'reset', 'network', 'other'])(
    'причина «%s» перехода на HTTP не вызывает',
    async (reason) => {
      const fake = scripted([() => unreachable(reason)]);

      const result = await createConnector(fake).connect(address('192.0.2.10'));

      expect(errorOf(result)).toEqual({ code: 'scannerUnreachable', details: { reason } });
      expect(fake.targets()).toEqual(['https:443']);
    },
  );

  it('HTTPS ответил, но это не сканер — перехода нет', async () => {
    const fake = scripted([() => reply(404)]);

    await createConnector(fake).connect(address('192.0.2.10'));

    expect(fake.targets()).toEqual(['https:443']);
  });

  it('явная схема https никогда не повторяется по HTTP', async () => {
    const fake = scripted([() => unreachable('refused')]);

    const result = await createConnector(fake).connect(address('https://192.0.2.10'));

    expect(errorOf(result)?.details).toEqual({ reason: 'refused' });
    expect(fake.targets()).toEqual(['https:443']);
  });

  it('явная схема http идёт сразу по HTTP', async () => {
    const fake = scripted([() => reply(200, CAPABILITIES)]);

    const result = await createConnector(fake).connect(address('http://192.0.2.10'));

    expect(fake.targets()).toEqual(['http:80']);
    expect(result.ok).toBe(true);
  });

  it('обе попытки отказали — возвращается отказ второй', async () => {
    const fake = scripted([() => unreachable('tls'), () => reply(404)]);

    const result = await createConnector(fake).connect(address('192.0.2.10'));

    expect(errorOf(result)?.code).toBe('notEsclScanner');
  });
});

describe('подключение: одно за раз (KTD-39)', () => {
  const pending = (signal: AbortSignal | undefined, late: Answer): Promise<Answer> =>
    new Promise((resolve) => {
      signal?.addEventListener('abort', () => {
        resolve(late);
      });
    });

  it('второе подключение отменяет первое; позднее завершение первого профиль не создаёт', async () => {
    // Первая проба «завершается успехом» уже после отмены — профиля из неё быть не должно.
    const fake = scripted([
      (signal) => pending(signal, reply(200, CAPABILITIES)) as Promise<Result<BufferedResponse>>,
      () => reply(200, CAPABILITIES),
    ]);
    const connector = createConnector(fake);

    const first = connector.connect(address('192.0.2.10'));
    const second = connector.connect(address('192.0.2.20'));

    expect(await first).toEqual(fail('canceled'));
    const result = await second;
    expect(result.ok && result.value.profile.host).toBe('192.0.2.20');
    expect(fake.closed()).toBe(2);
  });

  it('cancel отменяет идущее подключение', async () => {
    const fake = scripted([
      (signal) => pending(signal, fail('canceled')) as Promise<Result<BufferedResponse>>,
    ]);
    const connector = createConnector(fake);

    const running = connector.connect(address('192.0.2.10'));
    connector.cancel();

    expect(await running).toEqual(fail('canceled'));
  });

  it('отмена между попытками: до HTTP дело не доходит', async () => {
    const fake = scripted([
      () => unreachable('refused'),
      (signal) => (signal?.aborted === true ? fail('canceled') : reply(200, CAPABILITIES)),
    ]);
    const connector = createConnector({
      createTransport: (profile) => {
        const transport = fake.createTransport(profile);
        return {
          ...transport,
          request: async (options) => {
            const result = await transport.request(options);
            if (profile.scheme === 'https') {
              connector.cancel();
            }
            return result;
          },
        };
      },
    });

    expect(await connector.connect(address('192.0.2.10'))).toEqual(fail('canceled'));
  });
});

// ---------------------------------------------------------------------------------------------

/** Часы без настоящего ожидания: пауза только сдвигает время и попадает в список. */
function fakeClock(onSleep?: (ms: number) => void) {
  let now = 0;
  const sleeps: number[] = [];
  const clock: ProbeClock = {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      sleeps.push(ms);
      onSleep?.(ms);
      return Promise.resolve();
    },
  };
  return { clock, sleeps };
}

const PROFILE: ScannerProfile = {
  scheme: 'https',
  host: '192.0.2.10',
  port: 443,
  basePath: '/eSCL',
  fingerprint: FINGERPRINT,
};

const busyReplies = (count: number) => Array.from({ length: count }, () => () => reply(503));

describe('проба: ожидание «занят» (M5, KTD6)', () => {
  it('capabilities 503, 503, 200 — проба успешна после двух пауз по 1 с; транспорт один', async () => {
    const fake = scripted([...busyReplies(2), () => reply(200, CAPABILITIES)]);
    const { clock, sleeps } = fakeClock();

    const result = await probeScanner(PROFILE, { ...fake, clock });

    expect(result.ok).toBe(true);
    expect(sleeps).toEqual([1000, 1000]);
    expect(fake.paths).toEqual(Array(3).fill('/eSCL/ScannerCapabilities'));
    expect(fake.closed()).toBe(1);
  });

  it('503 до потолка ~15 с — scannerBusy', async () => {
    const fake = scripted(busyReplies(30));
    const { clock, sleeps } = fakeClock();

    const result = await probeScanner(PROFILE, { ...fake, clock });

    expect(result).toEqual(fail('scannerBusy'));
    // Повтор раз в секунду, пока следующая пауза не выводит за потолок.
    expect(sleeps).toEqual(Array(15).fill(1000));
    expect(fake.paths).toHaveLength(16);
    expect(fake.closed()).toBe(1);
  });

  it('отмена во время паузы — canceled, дальнейших запросов нет', async () => {
    const controller = new AbortController();
    const fake = scripted(busyReplies(5));
    const { clock } = fakeClock(() => {
      controller.abort();
    });

    const result = await probeScanner(PROFILE, { ...fake, clock }, { signal: controller.signal });

    expect(result).toEqual(fail('canceled'));
    expect(fake.paths).toHaveLength(1);
    expect(fake.closed()).toBe(1);
  });

  it('о первом HTTP-ответе проба сообщает сразу, итог — после повторов', async () => {
    const events: string[] = [];
    const fake = scripted([...busyReplies(2), () => reply(200, CAPABILITIES)]);
    const { clock } = fakeClock(() => events.push('пауза'));
    const createTransport = (profile: ScannerProfile): ScannerTransport => {
      const transport = fake.createTransport(profile);
      return {
        ...transport,
        request: (options) => {
          events.push('запрос');
          return transport.request(options);
        },
      };
    };

    const result = await probeScanner(
      PROFILE,
      { createTransport, clock },
      { onResponse: () => events.push('ответ') },
    );

    expect(result.ok).toBe(true);
    // Уведомление — одно, до первой паузы.
    expect(events).toEqual(['запрос', 'ответ', 'пауза', 'запрос', 'пауза', 'запрос']);
  });

  it('без HTTP-ответа уведомления нет', async () => {
    const fake = scripted([() => unreachable('timeout')]);
    let responses = 0;

    await probeScanner(PROFILE, fake, {
      onResponse: () => {
        responses += 1;
      },
    });

    expect(responses).toBe(0);
  });

  it('режим кандидата (ожидание выключено): 503 — scannerBusy сразу, без пауз', async () => {
    const fake = scripted(busyReplies(1));
    const { clock, sleeps } = fakeClock();

    const result = await probeScanner(PROFILE, { ...fake, clock }, { waitBusy: false });

    expect(result).toEqual(fail('scannerBusy'));
    expect(sleeps).toEqual([]);
    expect(fake.paths).toHaveLength(1);
  });

  it.each([500, 502, 504])('ответ %i не пережидается — «не сканер» с кодом', async (status) => {
    const fake = scripted([() => reply(status)]);
    const { clock, sleeps } = fakeClock();

    const result = await probeScanner(PROFILE, { ...fake, clock });

    expect(result).toEqual(fail('notEsclScanner', { status }));
    expect(sleeps).toEqual([]);
  });

  it('ручное подключение без схемы: 503 на HTTPS до потолка — scannerBusy, попытки HTTP нет', async () => {
    const fake = scripted(busyReplies(30));
    const { clock } = fakeClock();

    const result = await createConnector({ ...fake, clock }).connect(address('192.0.2.10'));

    expect(result).toEqual(fail('scannerBusy'));
    expect(new Set(fake.targets())).toEqual(new Set(['https:443']));
  });

  it('cancel подключения во время ожидания «занят» — canceled без новых запросов', async () => {
    const fake = scripted(busyReplies(5));
    let connector: ReturnType<typeof createConnector> | null = null;
    const { clock } = fakeClock(() => connector?.cancel());
    connector = createConnector({ ...fake, clock });

    const result = await connector.connect(address('192.0.2.10'));

    expect(result).toEqual(fail('canceled'));
    expect(fake.paths).toHaveLength(1);
  });
});
