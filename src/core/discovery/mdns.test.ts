import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_DISCOVERED_SCANNERS,
  REQUERY_DELAYS_MS,
  startDiscovery,
  type MdnsBackend,
  type MdnsInstance,
} from './mdns';
import type { Announcement, ServiceType } from './txt';

// Обнаружение на подставной библиотеке: сетевых сокетов тест не открывает.

const UUID = '00000000-0000-4000-8000-000000000000';

const announce = (address = '192.0.2.10', entries: string[] = []): Announcement => ({
  name: 'EPSON ET-3850 Series',
  port: 443,
  addresses: [address],
  txt: ['rs=eSCL', 'is=platen,adf', `UUID=${UUID}`, ...entries].map((entry) =>
    new TextEncoder().encode(entry),
  ),
});

interface FakeInstance {
  readonly address: string;
  readonly browsed: ServiceType[];
  destroyed: number;
  requeried: number;
  emit(type: ServiceType, announcement: Announcement): void;
  fail(): void;
}

interface FakeOptions {
  /** Интерфейсы, на которых сокет не открывается. */
  readonly failOpen?: readonly string[];
  /** Интерфейсы, на которых сокет открылся, а поиск начать не удалось. */
  readonly failBrowse?: readonly string[];
}

function fakeBackend(options: FakeOptions = {}) {
  const instances: FakeInstance[] = [];
  const backend: MdnsBackend = {
    open(address, onError) {
      if (options.failOpen?.includes(address) === true) {
        throw Object.assign(new Error('bind'), { code: 'EADDRINUSE' });
      }
      const listeners = new Map<ServiceType, (announcement: Announcement) => void>();
      const fake: FakeInstance = {
        address,
        browsed: [],
        destroyed: 0,
        requeried: 0,
        emit: (type, announcement) => listeners.get(type)?.(announcement),
        fail: () => {
          onError(Object.assign(new Error('socket'), { code: 'EACCES' }));
        },
      };
      instances.push(fake);
      const instance: MdnsInstance = {
        browse(type, onUp) {
          if (options.failBrowse?.includes(address) === true) {
            throw Object.assign(new Error('membership'), { code: 'EADDRNOTAVAIL' });
          }
          fake.browsed.push(type);
          listeners.set(type, onUp);
        },
        requery() {
          fake.requeried += 1;
        },
        destroy() {
          fake.destroyed += 1;
        },
      };
      return instance;
    },
  };
  return { backend, instances };
}

function start(interfaces: string[], options: FakeOptions = {}) {
  const fake = fakeBackend(options);
  let changes = 0;
  const discovery = startDiscovery({
    backend: fake.backend,
    interfaces: () => interfaces,
    onChange: () => {
      changes += 1;
    },
  });
  return { discovery, instances: fake.instances, changes: () => changes };
}

describe('обнаружение по mDNS', () => {
  it('по экземпляру на каждый внешний IPv4-интерфейс, оба сервиса на каждом', () => {
    const { instances } = start(['192.0.2.2', '198.51.100.2']);

    expect(instances.map((it) => it.address)).toEqual(['192.0.2.2', '198.51.100.2']);
    expect(instances.map((it) => it.browsed)).toEqual([
      ['uscan', 'uscans'],
      ['uscan', 'uscans'],
    ]);
  });

  it('устройство от двух сервисов и на двух интерфейсах — одна запись, одно уведомление', () => {
    const { discovery, instances, changes } = start(['192.0.2.2', '198.51.100.2']);

    for (const instance of instances) {
      instance.emit('uscan', announce());
      instance.emit('uscans', announce());
    }

    const { scanners, failure } = discovery.state();
    expect(failure).toBeNull();
    expect(scanners).toHaveLength(1);
    expect(scanners[0]).toMatchObject({
      name: 'EPSON ET-3850 Series',
      address: '192.0.2.10',
      port: 443,
      hasAdf: true,
    });
    expect(changes()).toBe(1);
  });

  it('снимок для интерфейса не несёт ни UUID, ни пути, ни ссылок из TXT', () => {
    const { discovery, instances } = start(['192.0.2.2']);
    instances[0]?.emit('uscans', announce('192.0.2.10', ['adminurl=http://192.0.2.10/admin']));

    const [scanner] = discovery.state().scanners;

    expect(Object.keys(scanner ?? {}).sort()).toEqual(['address', 'hasAdf', 'id', 'name', 'port']);
    expect(JSON.stringify(scanner)).not.toContain('admin');
  });

  it('идентификатор непрозрачен и ведёт к адресу подключения: схема не названа', () => {
    const { discovery, instances } = start(['192.0.2.2']);
    instances[0]?.emit('uscans', announce('192.0.2.10', []));

    const id = discovery.state().scanners[0]?.id ?? '';

    expect(id).not.toContain('192.0.2.10');
    expect(discovery.addressOf(id)).toEqual({
      scheme: null,
      host: '192.0.2.10',
      port: 443,
      basePath: '/eSCL',
    });
    expect(discovery.addressOf('192.0.2.10')).toBeNull();
    expect(discovery.addressOf('')).toBeNull();
  });

  it('устройство без автоподачи в списке есть, но не выбирается', () => {
    const { discovery, instances } = start(['192.0.2.2']);
    instances[0]?.emit('uscan', {
      ...announce('192.0.2.30'),
      txt: [new TextEncoder().encode('is=platen')],
    });

    const [scanner] = discovery.state().scanners;

    expect(scanner?.hasAdf).toBe(false);
    expect(discovery.addressOf(scanner?.id ?? '')).toBeNull();
  });

  it('идентификатор прошлого поиска в новом не действует', () => {
    const first = start(['192.0.2.2']);
    first.instances[0]?.emit('uscan', announce());
    const second = start(['192.0.2.2']);
    second.instances[0]?.emit('uscan', announce('192.0.2.99'));

    const stale = first.discovery.state().scanners[0]?.id ?? '';

    expect(second.discovery.addressOf(stale)).toBeNull();
  });

  it('поток объявлений упирается в потолок числа записей', () => {
    const { discovery, instances, changes } = start(['192.0.2.2']);

    for (let index = 0; index < 500; index += 1) {
      instances[0]?.emit('uscan', announce(`198.51.${Math.floor(index / 250)}.${index % 250}`));
    }

    expect(discovery.state().scanners).toHaveLength(MAX_DISCOVERED_SCANNERS);
    expect(changes()).toBe(MAX_DISCOVERED_SCANNERS);
  });

  it('объявление, по которому нельзя подключиться, в список не попадает', () => {
    const { discovery, instances, changes } = start(['192.0.2.2']);

    instances[0]?.emit('uscan', { ...announce(), addresses: ['2001:db8::10'] });
    instances[0]?.emit('uscan', { ...announce(), port: 0 });

    expect(discovery.state().scanners).toEqual([]);
    expect(changes()).toBe(0);
  });
});

describe('обнаружение: повтор запроса', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('запрос повторяется с растущей паузой, пока идёт поиск, и прекращается с остановкой', () => {
    vi.useFakeTimers();
    const { discovery, instances } = start(['192.0.2.2', '198.51.100.2']);
    const counts = (): number[] => instances.map((it) => it.requeried);

    expect(counts()).toEqual([0, 0]);
    vi.advanceTimersByTime(999);
    expect(counts()).toEqual([0, 0]);
    vi.advanceTimersByTime(1);
    expect(counts()).toEqual([1, 1]);
    vi.advanceTimersByTime(2000 + 4000 + 8000);
    expect(counts()).toEqual([4, 4]);
    // Дальше — с последней паузой.
    vi.advanceTimersByTime(REQUERY_DELAYS_MS.at(-1) ?? 0);
    expect(counts()).toEqual([5, 5]);

    discovery.stop();
    vi.advanceTimersByTime(60_000);
    expect(counts()).toEqual([5, 5]);
  });

  it('экземпляр с отказавшим сокетом в повторе не участвует', () => {
    vi.useFakeTimers();
    const { instances } = start(['192.0.2.2', '198.51.100.2']);

    instances[0]?.fail();
    vi.advanceTimersByTime(1000);

    expect(instances.map((it) => it.requeried)).toEqual([0, 1]);
  });

  it('когда отказали все сокеты, повтор прекращается', () => {
    vi.useFakeTimers();
    const { instances } = start(['192.0.2.2']);

    instances[0]?.fail();
    vi.advanceTimersByTime(1000);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('без единого открытого сокета таймер не заводится', () => {
    vi.useFakeTimers();
    start([]);
    start(['192.0.2.2'], { failOpen: ['192.0.2.2'] });

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('обнаружение: сбой и остановка', () => {
  it('сокет открылся, а поиск начать не удалось — сокет закрыт, а не брошен открытым', () => {
    const { discovery, instances, changes } = start(['192.0.2.2', '198.51.100.2'], {
      failBrowse: ['192.0.2.2'],
    });

    expect(instances.map((it) => it.destroyed)).toEqual([1, 0]);
    expect(discovery.state().failure).toBeNull();
    // Пока поиск собирается, вызывающий не уведомляется: объекта поиска у него ещё нет.
    expect(changes()).toBe(0);

    discovery.stop();
    expect(instances.map((it) => it.destroyed)).toEqual([1, 1]);
  });

  it('поиск не начался ни на одном интерфейсе — сбой сокета', () => {
    const { discovery, instances } = start(['192.0.2.2'], { failBrowse: ['192.0.2.2'] });

    expect(discovery.state().failure).toBe('socket');
    expect(instances[0]?.destroyed).toBe(1);
  });

  it('ошибка сокета отличается от пустого результата', () => {
    const searching = start(['192.0.2.2']);
    const broken = start(['192.0.2.2'], { failOpen: ['192.0.2.2'] });

    expect(searching.discovery.state()).toEqual({ scanners: [], failure: null });
    expect(broken.discovery.state()).toEqual({ scanners: [], failure: 'socket' });
  });

  it('нет внешних интерфейсов — «нет сети», а не пустой результат', () => {
    const { discovery, instances } = start([]);

    expect(discovery.state()).toEqual({ scanners: [], failure: 'noNetwork' });
    expect(instances).toEqual([]);
  });

  it('сбой одного интерфейса из двух поиск не останавливает', () => {
    const { discovery, instances } = start(['192.0.2.2', '198.51.100.2'], {
      failOpen: ['192.0.2.2'],
    });
    instances[0]?.emit('uscan', announce());

    expect(instances.map((it) => it.address)).toEqual(['198.51.100.2']);
    expect(discovery.state().failure).toBeNull();
    expect(discovery.state().scanners).toHaveLength(1);
  });

  it('отложенная ошибка сокета закрывает экземпляр; когда отказали все — сбой', () => {
    const { discovery, instances, changes } = start(['192.0.2.2', '198.51.100.2']);

    instances[0]?.fail();
    expect(discovery.state().failure).toBeNull();
    instances[1]?.fail();
    instances[1]?.fail();

    expect(discovery.state().failure).toBe('socket');
    expect(instances.map((it) => it.destroyed)).toEqual([1, 1]);
    expect(changes()).toBe(2);
  });

  it('поиск останавливается по команде и освобождает сокеты', () => {
    const { discovery, instances, changes } = start(['192.0.2.2', '198.51.100.2']);
    instances[0]?.emit('uscan', announce());

    discovery.stop();
    discovery.stop();
    instances[1]?.emit('uscan', announce('192.0.2.50'));
    instances[1]?.fail();

    expect(instances.map((it) => it.destroyed)).toEqual([1, 1]);
    // Найденное до остановки остаётся; новое не принимается, остановка сбоем не считается.
    expect(discovery.state().scanners).toHaveLength(1);
    expect(discovery.state().failure).toBeNull();
    expect(changes()).toBe(1);
    expect(discovery.addressOf(discovery.state().scanners[0]?.id ?? '')?.host).toBe('192.0.2.10');
  });
});
