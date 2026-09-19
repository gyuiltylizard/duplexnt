// Спайк M0, критерий 1 ADR 0003: mDNS-обнаружение сканера БЕЗ службы Bonjour, чистым JS.
// Одноразовый код: не рефакторится, тестами не покрывается.
//
// Запуск:  node spikes/mdns-discover.mjs [секунд]
// Тот же файл запускает установленный exe в режиме Node (U11, проверка файрвола).
//
// Сырой отчёт (адреса, имена хостов, значения TXT) — в local-test-data/device/ (вне git).
// В stdout — только форма: типы сервисов, набор и регистр ключей TXT, значения из
// неидентифицирующего списка, тип интерфейса.

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';

// Библиотека ищется от рабочего каталога, а не от файла скрипта: установленный exe (U11)
// запускает этот файл из каталога проекта, где лежит node_modules.
const require = createRequire(join(process.cwd(), 'package.json'));
const { Bonjour } = require('bonjour-service');

const SERVICE_TYPES = ['uscan', 'uscans'];
const SAFE_TXT_KEYS = new Set([
  'txtvers',
  'vers',
  'rs',
  'cs',
  'is',
  'pdl',
  'duplex',
  'ty',
  'mfg',
  'mdl',
]);
const seconds = Number(process.argv[2] ?? 8);

function interfaceOf(address) {
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const mask = entry.netmask.split('.').map(Number);
      const same = entry.address
        .split('.')
        .map(Number)
        .every(
          (octet, index) =>
            (octet & mask[index]) === (Number(address.split('.')[index]) & mask[index]),
        );
      if (same) return name;
    }
  }
  return 'не определён';
}

// Multicast по умолчанию уходит в интерфейс с наименьшей метрикой, а на машине с Hyper-V и WSL
// это виртуальный адаптер: запрос до домашней сети не доходит. Поэтому — явный перебор всех
// внешних IPv4-интерфейсов, по экземпляру на каждый. Режим `default` оставлен для сравнения.
const mode = process.argv[3] ?? 'each';
const bindings =
  mode === 'default'
    ? [{ name: 'по умолчанию', options: {} }]
    : Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
        (entries ?? [])
          .filter((entry) => entry.family === 'IPv4' && !entry.internal)
          .map((entry) => ({ name, options: { interface: entry.address } })),
      );

// reuseAddr обязателен: порт 5353 на Windows уже делят служба Bonjour, DNS-клиент системы и
// приложения вроде Spotify и Steam.
const found = [];
const socketErrors = [];
const instances = bindings.map(({ name, options }) => {
  const bonjour = new Bonjour({ reuseAddr: true, ...options }, (error) => {
    socketErrors.push({ interface: name, code: error?.code ?? String(error) });
  });
  const browsers = SERVICE_TYPES.map((type) =>
    bonjour.find({ type, protocol: 'tcp' }, (service) => {
      found.push({ serviceType: `_${type}._tcp`, boundTo: name, service });
    }),
  );
  return { bonjour, browsers };
});

setTimeout(() => {
  for (const { bonjour, browsers } of instances) {
    browsers.forEach((browser) => browser.stop());
    bonjour.destroy();
  }

  const raw = found.map(({ serviceType, boundTo, service }) => ({
    serviceType,
    boundTo,
    name: service.name,
    host: service.host,
    port: service.port,
    addresses: service.addresses,
    referer: service.referer,
    txt: service.txt,
  }));
  mkdirSync(resolve('local-test-data/device'), { recursive: true });
  writeFileSync(
    resolve('local-test-data/device', `mdns-report-${Date.now()}.json`),
    JSON.stringify(raw, null, 2),
  );

  const safe = found.map(({ serviceType, boundTo, service }) => {
    const txt = service.txt ?? {};
    const ipv4 = (service.addresses ?? []).filter((address) => !address.includes(':'));
    return {
      serviceType,
      boundTo,
      port: service.port,
      addresses: { ipv4: ipv4.length, ipv6: (service.addresses ?? []).length - ipv4.length },
      interface: service.referer?.address ? interfaceOf(service.referer.address) : 'нет referer',
      txtKeys: Object.keys(txt),
      txtSafeValues: Object.fromEntries(
        Object.entries(txt).filter(([key]) => SAFE_TXT_KEYS.has(key.toLowerCase())),
      ),
      hasRs: Object.keys(txt).some((key) => key.toLowerCase() === 'rs'),
    };
  });

  console.log(
    JSON.stringify(
      {
        runtime: process.versions.electron ? 'electron-as-node' : 'node',
        seconds,
        mode,
        interfacesTried: bindings.map((binding) => binding.name),
        socketErrors,
        found: safe,
      },
      null,
      2,
    ),
  );
  process.exitCode = safe.some((entry) => entry.hasRs) ? 0 : 1;
}, seconds * 1000);
