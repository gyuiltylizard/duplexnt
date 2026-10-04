import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { bonjourBackend, startDiscovery } from '../../src/core/discovery/mdns';

// Настоящая библиотека mDNS на адресе, которого у машины нет: сокет открыть нельзя, сеть не
// нужна. Проверяется договор `MdnsBackend.open`: ошибка сокета приходит в обработчик, а не
// необработанным исключением, — в main-процессе оно уронило бы приложение. bonjour-service сама
// на событие ошибки сокета не подписывается.

// Документационный диапазон RFC 5737: ни на одном интерфейсе такого адреса нет.
const NO_SUCH_INTERFACE = '192.0.2.1';

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt += 1) {
    await delay(5);
  }
}

describe('обнаружение на настоящей библиотеке', () => {
  it('ошибка открытия сокета приходит в обработчик, сокет после неё закрывается', async () => {
    const errors: unknown[] = [];
    const instance = bonjourBackend.open(NO_SUCH_INTERFACE, (error) => errors.push(error));
    instance.browse('uscan', () => undefined);

    await until(() => errors.length > 0);

    expect(errors).toHaveLength(1);
    expect((errors[0] as { code?: string }).code).toBe('EADDRNOTAVAIL');
    expect(() => {
      instance.destroy();
    }).not.toThrow();
  });

  it('поиск на таком интерфейсе сообщает сбой сокета, а не пустой результат', async () => {
    let changes = 0;
    const discovery = startDiscovery({
      interfaces: () => [NO_SUCH_INTERFACE],
      onChange: () => {
        changes += 1;
      },
    });
    expect(discovery.state().failure).toBeNull();

    await until(() => discovery.state().failure !== null);

    expect(discovery.state()).toEqual({ scanners: [], failure: 'socket' });
    expect(changes).toBe(1);
    discovery.stop();
  });
});
