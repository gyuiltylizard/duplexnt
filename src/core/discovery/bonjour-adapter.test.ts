import { EventEmitter } from 'node:events';
import Bonjour from 'bonjour-service';
import { describe, expect, it } from 'vitest';
import { collectAddresses, requeryBrowser, watchBrowser } from './mdns';
import type { Announcement } from './txt';

// Адаптер к bonjour-service на настоящем классе поиска библиотеки и подставном сокете: пакеты
// подаются событием, сеть не трогается. Подставная библиотека в ./mdns.test.ts этих свойств не
// ловит — она моделирует интерфейс, а не поведение bonjour-service.

const SERVICE = '_uscan._tcp.local';

interface Rr {
  readonly name: string;
  readonly type: 'PTR' | 'SRV' | 'TXT' | 'A';
  readonly ttl: number;
  readonly data: unknown;
}

const packet = (...answers: Rr[]) => ({ answers, additionals: [] as Rr[] });

const addressRecord = (host: string, address: string): Rr => ({
  name: host,
  type: 'A',
  ttl: 120,
  data: address,
});

/** Ответ устройства: PTR, SRV, TXT и, если адрес назван, запись A. */
function response(instance: string, host: string, address: string | null, txt = ['rs=eSCL']) {
  const fqdn = `${instance}.${SERVICE}`;
  return packet(
    { name: SERVICE, type: 'PTR', ttl: 4500, data: fqdn },
    { name: fqdn, type: 'SRV', ttl: 120, data: { target: host, port: 443 } },
    { name: fqdn, type: 'TXT', ttl: 4500, data: txt.map((entry) => Buffer.from(entry)) },
    ...(address === null ? [] : [addressRecord(host, address)]),
  );
}

function setup() {
  let queries = 0;
  const socket = Object.assign(new EventEmitter(), {
    query: () => {
      queries += 1;
    },
  });
  // Память адресов — до поиска, как в настоящем адаптере: пакет она видит раньше библиотеки.
  const addressesOf = collectAddresses(socket);
  const browser = new Bonjour.Browser(socket, { type: 'uscan', protocol: 'tcp' });
  const seen: Announcement[] = [];
  watchBrowser(browser, (announcement) => seen.push(announcement), addressesOf);
  const receive = (incoming: unknown): void => {
    socket.emit('response', incoming, {
      address: '192.0.2.10',
      family: 'IPv4',
      port: 5353,
      size: 0,
    });
  };
  return { browser, seen, receive, addressesOf, queries: () => queries };
}

const addresses = (seen: readonly Announcement[]): string[][] =>
  seen.map((it) => [...it.addresses]);

describe('адаптер bonjour-service', () => {
  it('полное объявление доходит с адресом, портом и сырыми записями TXT', () => {
    const { seen, receive } = setup();

    receive(response('EPSON', 'epson.local', '192.0.2.10', ['rs=eSCL', 'note=']));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ name: 'EPSON', port: 443, addresses: ['192.0.2.10'] });
    expect(seen[0]?.txt.map((entry) => Buffer.from(entry).toString())).toEqual([
      'rs=eSCL',
      'note=',
    ]);
  });

  it('ответ без записи A дополняется адресом хоста из прежнего ответа', () => {
    const { seen, receive } = setup();

    // Так отвечает ET-3850: запись A, только что разосланную в ответ на соседний запрос, он во
    // втором ответе опускает.
    receive(packet(addressRecord('EPSON.local', '192.0.2.10')));
    receive(response('EPSON', 'epson.local', null));

    expect(addresses(seen)).toEqual([['192.0.2.10']]);
  });

  it('первое объявление без адреса не прячет устройство: после повтора оно объявлено снова', () => {
    const { seen, receive, browser, queries } = setup();
    receive(response('EPSON', 'epson.local', null));
    // Адрес пришёл позже, но библиотека считает сервис известным и заново его не объявляет.
    receive(response('EPSON', 'epson.local', '192.0.2.10'));
    expect(addresses(seen)).toEqual([[]]);

    const before = queries();
    requeryBrowser(browser);
    // Ответ на повтор снова без записи A — адрес берётся из памяти.
    receive(response('EPSON', 'epson.local', null));

    expect(queries()).toBe(before + 1);
    expect(addresses(seen)).toEqual([[], ['192.0.2.10']]);
  });

  it('чужое объявление под тем же именем сервиса не заслоняет настоящее', () => {
    const { seen, receive } = setup();

    receive(response('EPSON', 'attacker.local', '192.0.2.66'));
    receive(response('EPSON', 'epson.local', '192.0.2.10'));

    expect(addresses(seen)).toEqual([['192.0.2.66'], ['192.0.2.10']]);
  });

  it('сменившийся TXT известного сервиса доходит как новое объявление', () => {
    const { seen, receive } = setup();

    receive(response('EPSON', 'epson.local', '192.0.2.10', ['is=platen']));
    receive(response('EPSON', 'epson.local', '192.0.2.10', ['is=platen,adf']));

    expect(seen.map((it) => Buffer.from(it.txt[0] ?? []).toString())).toEqual([
      'is=platen',
      'is=platen,adf',
    ]);
  });

  it('список известных сервисов библиотеки не растёт без потолка: повтор его очищает', () => {
    const { receive, browser } = setup();
    for (let index = 0; index < 500; index += 1) {
      receive(response(`flood-${index}`, `host-${index}.local`, '192.0.2.66'));
    }
    expect(browser.services).toHaveLength(500);

    requeryBrowser(browser);

    expect(browser.services).toHaveLength(0);
  });

  it('память адресов ограничена: числом хостов и числом адресов на хост', () => {
    const { receive, addressesOf } = setup();

    for (let index = 0; index < 20; index += 1) {
      receive(packet(addressRecord('epson.local', `192.0.2.${index}`)));
    }
    for (let index = 0; index < 400; index += 1) {
      receive(packet(addressRecord(`host-${index}.local`, '192.0.2.66')));
    }

    expect(addressesOf('epson.local')).toHaveLength(8);
    // Потолок в 256 хостов считает и первый: вошли хосты с нулевого по 254-й.
    expect(addressesOf('host-254.local')).toEqual(['192.0.2.66']);
    expect(addressesOf('host-255.local')).toEqual([]);
  });

  it('мусор вместо пакета память адресов не роняет', () => {
    // Без поиска библиотеки: multicast-dns такого пакета не выдаст, проверяется сама память.
    const socket = new EventEmitter();
    const addressesOf = collectAddresses(socket);

    socket.emit('response', {
      answers: [null, 7, { type: 'A' }, { type: 'A', name: 'x.local', data: 5 }],
    });
    socket.emit('response', { answers: 'не массив' });
    socket.emit('response', null);

    expect(addressesOf('x.local')).toEqual([]);
  });
});
