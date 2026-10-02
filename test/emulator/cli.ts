import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { isScenarioName, SCENARIOS, type Scenario } from './scenarios.ts';
import { startEmulator } from './server.ts';

// `npm run emulator` — эмулятор сканера на фиксированном порту для ручного смоука (план M1, U9).
// Подключение в приложении — ручным вводом адреса `127.0.0.1:9443`.
//
// Сертификат создаётся на каждый запуск, ключ живёт в памяти (KTD-29): после перезапуска
// эмулятора приложение увидит «другое устройство». Поэтому сценарий меняется без перезапуска —
// строкой в консоли.

const DEFAULT_PORT = 9443;
// Лист едет через настоящий сканер около десяти секунд; для смоука хватит заметной паузы.
const DEFAULT_PAGE_DELAY_MS = 1200;

const { values } = parseArgs({
  options: {
    scenario: { type: 'string', default: 'pass-12' },
    sheets: { type: 'string' },
    port: { type: 'string', default: String(DEFAULT_PORT) },
    'page-delay': { type: 'string', default: String(DEFAULT_PAGE_DELAY_MS) },
    http: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
  },
});

const names = Object.keys(SCENARIOS).join(', ');
if (values.list) {
  console.log(names);
  process.exit(0);
}

function scenarioFor(name: string): Partial<Scenario> | null {
  if (!isScenarioName(name)) {
    return null;
  }
  return {
    pageDelayMs: Number(values['page-delay']),
    ...SCENARIOS[name],
    ...(values.sheets === undefined ? {} : { sheets: Number(values.sheets) }),
  };
}

const initial = scenarioFor(values.scenario);
if (initial === null) {
  console.error(`неизвестный сценарий «${values.scenario}»; есть: ${names}`);
  process.exit(1);
}

const emulator = await startEmulator({
  scenario: initial,
  port: Number(values.port),
  http: values.http,
  onExchange: ({ method, path, status }) => {
    console.log(`  ${method} ${path} → ${status ?? 'нет ответа'}`);
  },
});

console.log(
  `эмулятор сканера: ${emulator.scheme}://${emulator.host}:${emulator.port}${emulator.basePath}`,
);
console.log(`сценарий: ${values.scenario}`);
console.log(
  'в консоли: имя сценария — сменить сценарий и перезарядить лоток; clear — снять замятие;',
);
console.log('           list — список сценариев; Ctrl+C — выход');

createInterface({ input: process.stdin }).on('line', (line) => {
  const command = line.trim();
  if (command === '') {
    return;
  }
  if (command === 'list') {
    console.log(names);
    return;
  }
  if (command === 'clear') {
    emulator.clearJam();
    console.log('замятие снято');
    return;
  }
  const next = scenarioFor(command);
  if (next === null) {
    console.log(`неизвестная команда или сценарий «${command}»; есть: ${names}`);
    return;
  }
  emulator.load(next);
  console.log(`сценарий: ${command}`);
});

process.on('SIGINT', () => {
  void emulator.close().then(() => process.exit(0));
});
