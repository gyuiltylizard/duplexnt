import { describe, expect, it } from 'vitest';
import {
  findByUuid,
  UUID_SEARCH_WINDOW_MS,
  type SearchClock,
  type UuidCandidate,
} from './find-by-uuid';
import type { MdnsBackend } from './mdns';
import type { Announcement, ServiceType } from './txt';

// Поиск запомненного сканера по UUID на подставной библиотеке и подставных часах: сокетов тест
// не открывает и реального времени не ждёт.

const UUID = 'cbfd4f3e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const OTHER_UUID = '00000000-0000-4000-8000-000000000000';

const announce = (
  options: { address?: string; port?: number; uuid?: string | null } = {},
): Announcement => ({
  name: 'EPSON ET-3850 Series',
  port: options.port ?? 443,
  addresses: [options.address ?? '192.0.2.10'],
  txt: [
    'rs=eSCL',
    'is=platen,adf',
    ...(options.uuid === null ? [] : [`UUID=${options.uuid ?? UUID}`]),
  ].map((entry) => new TextEncoder().encode(entry)),
});

interface FakeInstance {
  destroyed: number;
  emit(type: ServiceType, announcement: Announcement): void;
  fail(): void;
}

// Урезанная копия фейка из ./mdns.test.ts: здесь нужны только объявления, сбой и закрытие.
function fakeBackend(failOpen: readonly string[] = []) {
  const instances: FakeInstance[] = [];
  const backend: MdnsBackend = {
    open(address, onError) {
      if (failOpen.includes(address)) {
        throw Object.assign(new Error('bind'), { code: 'EADDRINUSE' });
      }
      const listeners = new Map<ServiceType, (announcement: Announcement) => void>();
      const fake: FakeInstance = {
        destroyed: 0,
        emit: (type, announcement) => listeners.get(type)?.(announcement),
        fail: () => {
          onError(Object.assign(new Error('socket'), { code: 'EACCES' }));
        },
      };
      instances.push(fake);
      return {
        browse(type, onUp) {
          listeners.set(type, onUp);
        },
        requery() {
          // Повтор запроса здесь не проверяется.
        },
        destroy() {
          fake.destroyed += 1;
        },
      };
    },
  };
  return { backend, instances };
}

// Окно приёма заводится после возврата объекта поиска — через микрозадачу.
const started = (): Promise<void> => Promise.resolve();

// Часы, у которых время идёт только по команде теста.
function manualClock() {
  const sleeps: { ms: number; signal: AbortSignal | undefined; wake: () => void }[] = [];
  const clock: SearchClock = {
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        sleeps.push({ ms, signal, wake: resolve });
        signal?.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      }),
  };
  return { clock, sleeps };
}

interface SearchSetup {
  readonly uuid?: string;
  readonly interfaces?: readonly string[];
  readonly failOpen?: readonly string[];
  readonly signal?: AbortSignal;
  readonly onCandidate?: (candidate: UuidCandidate) => void;
}

function search(setup: SearchSetup = {}) {
  const fake = fakeBackend(setup.failOpen);
  const time = manualClock();
  const candidates: UuidCandidate[] = [];
  const handle = findByUuid({
    uuid: setup.uuid ?? UUID,
    onCandidate: (candidate) => {
      candidates.push(candidate);
      setup.onCandidate?.(candidate);
    },
    clock: time.clock,
    discovery: {
      backend: fake.backend,
      interfaces: () => setup.interfaces ?? ['192.0.2.2'],
    },
    ...(setup.signal === undefined ? {} : { signal: setup.signal }),
  });
  const destroyed = (): number[] => fake.instances.map((it) => it.destroyed);
  return { handle, candidates, instances: fake.instances, sleeps: time.sleeps, destroyed };
}

describe('поиск по UUID: кандидаты', () => {
  it('объявление с UUID запомненного — кандидат с адресом, портом и базовым путём', () => {
    const { handle, candidates, instances } = search();

    instances[0]?.emit('uscans', announce());

    expect(candidates).toEqual([{ address: '192.0.2.10', port: 443, basePath: '/eSCL' }]);
    handle.stop();
  });

  it('UUID сравнивается без учёта регистра с обеих сторон', () => {
    const { handle, candidates, instances } = search({ uuid: UUID.toUpperCase() });

    instances[0]?.emit(
      'uscans',
      announce({ uuid: `${UUID.slice(0, 8).toUpperCase()}${UUID.slice(8)}` }),
    );

    expect(candidates).toHaveLength(1);
    handle.stop();
  });

  it('объявление с другим UUID и без UUID — не кандидаты', () => {
    const { handle, candidates, instances } = search();

    instances[0]?.emit('uscans', announce({ address: '192.0.2.20', uuid: OTHER_UUID }));
    instances[0]?.emit('uscans', announce({ address: '192.0.2.30', uuid: null }));

    expect(candidates).toEqual([]);
    handle.stop();
  });

  it('один UUID на двух портах — два кандидата по мере появления', () => {
    const { handle, candidates, instances } = search();

    instances[0]?.emit('uscans', announce({ port: 443 }));
    expect(candidates.map((it) => it.port)).toEqual([443]);
    instances[0]?.emit('uscan', announce({ port: 80 }));

    expect(candidates.map((it) => it.port)).toEqual([443, 80]);
    handle.stop();
  });

  it('повтор адреса и порта — от второго сервиса, интерфейса, обновления — один кандидат', () => {
    const { handle, candidates, instances } = search({ interfaces: ['192.0.2.2', '198.51.100.2'] });

    for (const instance of instances) {
      instance.emit('uscan', announce());
      instance.emit('uscans', announce());
      instance.emit('uscans', announce());
    }

    expect(candidates).toHaveLength(1);
    handle.stop();
  });

  it('первое объявление без UUID, следующее с ним — кандидат появляется со вторым', () => {
    const { handle, candidates, instances } = search();

    instances[0]?.emit('uscan', announce({ uuid: null }));
    expect(candidates).toEqual([]);
    instances[0]?.emit('uscans', announce());

    expect(candidates).toHaveLength(1);
    handle.stop();
  });

  it('устройство без автоподачи — тоже кандидат: решает проба', () => {
    const { handle, candidates, instances } = search();

    instances[0]?.emit('uscans', {
      ...announce(),
      txt: ['is=platen', `UUID=${UUID}`].map((entry) => new TextEncoder().encode(entry)),
    });

    expect(candidates).toHaveLength(1);
    handle.stop();
  });
});

describe('поиск по UUID: завершение', () => {
  it('окно приёма истекло без совпадений — пусто, поиск остановлен, позднее не принято', async () => {
    const { handle, candidates, instances, sleeps, destroyed } = search();
    await started();
    instances[0]?.emit('uscans', announce({ uuid: OTHER_UUID }));

    expect(sleeps.map((it) => it.ms)).toEqual([UUID_SEARCH_WINDOW_MS]);
    sleeps[0]?.wake();

    await expect(handle.done).resolves.toBe('window');
    expect(destroyed()).toEqual([1]);
    instances[0]?.emit('uscans', announce());
    expect(candidates).toEqual([]);
  });

  it('отмена сигналом — завершение, поиск остановлен, окно снято', async () => {
    const controller = new AbortController();
    const { handle, sleeps, destroyed } = search({ signal: controller.signal });
    await started();

    controller.abort();

    await expect(handle.done).resolves.toBe('canceled');
    expect(destroyed()).toEqual([1]);
    expect(sleeps[0]?.signal?.aborted).toBe(true);
  });

  it('сигнал отменён до старта — сокеты не открываются', async () => {
    const controller = new AbortController();
    controller.abort();
    const { handle, instances, sleeps } = search({ signal: controller.signal });

    await expect(handle.done).resolves.toBe('canceled');
    expect(instances).toEqual([]);
    expect(sleeps).toEqual([]);
  });

  it('нет внешних интерфейсов — завершение сразу, без ожидания окна', async () => {
    const { handle, sleeps } = search({ interfaces: [] });

    await expect(handle.done).resolves.toBe('noNetwork');
    expect(sleeps).toEqual([]);
  });

  it('ни один сокет не открылся — сбой сразу, без ожидания окна', async () => {
    const { handle, sleeps } = search({ failOpen: ['192.0.2.2'] });

    await expect(handle.done).resolves.toBe('socket');
    expect(sleeps).toEqual([]);
  });

  it('сокеты отказали по одному — поиск идёт, пока жив хоть один; после последнего — сбой', async () => {
    const { handle, candidates, instances, sleeps } = search({
      interfaces: ['192.0.2.2', '198.51.100.2'],
    });
    let end: string | null = null;
    void handle.done.then((it) => (end = it));

    instances[0]?.fail();
    await Promise.resolve();
    expect(end).toBeNull();
    instances[1]?.emit('uscans', announce());
    instances[1]?.fail();

    await expect(handle.done).resolves.toBe('socket');
    // Найденное до сбоя вызывающий получил.
    expect(candidates).toHaveLength(1);
    expect(sleeps[0]?.signal?.aborted).toBe(true);
  });

  it('остановка вызывающим — поиск остановлен, новые объявления не принимаются', async () => {
    const { handle, candidates, instances, destroyed } = search();

    handle.stop();
    handle.stop();
    instances[0]?.emit('uscans', announce());

    await expect(handle.done).resolves.toBe('stopped');
    expect(destroyed()).toEqual([1]);
    expect(candidates).toEqual([]);
  });

  it('остановка из обработчика кандидата — следующие кандидаты не приходят', async () => {
    const fake = fakeBackend();
    const seen: UuidCandidate[] = [];
    // Две записи с UUID приходят ещё на старте поиска и прочитываются разом.
    const backend: MdnsBackend = {
      open(address, onError) {
        const instance = fake.backend.open(address, onError);
        return {
          ...instance,
          browse(type, onUp) {
            instance.browse(type, onUp);
            if (type === 'uscans') {
              onUp(announce({ port: 443 }));
              onUp(announce({ port: 80 }));
            }
          },
        };
      },
    };
    const handle = findByUuid({
      uuid: UUID,
      onCandidate: (candidate) => {
        seen.push(candidate);
        handle.stop();
      },
      clock: manualClock().clock,
      discovery: { backend, interfaces: () => ['192.0.2.2'] },
    });

    await expect(handle.done).resolves.toBe('stopped');
    expect(seen).toHaveLength(1);
    expect(fake.instances.map((it) => it.destroyed)).toEqual([1]);
  });

  it('исключение в обработчике вызывающего — поиск всё равно остановлен, исход несёт ошибку', async () => {
    const failure = new Error('обработчик');
    const { handle, instances, destroyed, sleeps } = search({
      onCandidate: () => {
        throw failure;
      },
    });
    await started();

    expect(() => instances[0]?.emit('uscans', announce())).not.toThrow();

    await expect(handle.done).rejects.toBe(failure);
    expect(destroyed()).toEqual([1]);
    expect(sleeps[0]?.signal?.aborted).toBe(true);
  });
});
