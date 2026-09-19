// Спайк M0, критерий 2 ADR 0003 — тот же сценарий из main-процесса Electron. Node слинкован с
// OpenSSL, Electron — с BoringSSL, поэтому результат Node на Electron не переносится.
//
// Запуск (ELECTRON_RUN_AS_NODE обязана быть снята):
//   node_modules\electron\dist\electron.exe spikes\tls-electron-main.cjs <адрес сканера>
//
// Скрипт ГРОМКО падает, если оказался не в настоящем main-процессе: иначе строка «Electron»
// в журнале описала бы режим Node.

if (!process.versions.electron || process.type !== 'browser' || process.env.ELECTRON_RUN_AS_NODE) {
  console.error(
    'СТОП: это не main-процесс Electron ' +
      `(electron=${process.versions.electron}, type=${process.type}, ` +
      `ELECTRON_RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE}). Сними переменную и запусти через electron.exe.`,
  );
  process.exit(2);
}

const { app, net } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

app.whenReady().then(async () => {
  let code = 1;
  try {
    const host =
      process.argv.slice(2).find((arg) => !arg.startsWith('-')) ??
      process.env.DUPLEXNT_SCANNER_HOST;
    const spike = await import(pathToFileURL(path.join(__dirname, 'tls-capabilities.mjs')).href);
    const report = await spike.run({ host, electronNet: net });
    console.log(JSON.stringify(report, null, 2));
    code = report.passed ? 0 : 1;
  } catch (error) {
    console.error('СПАЙК УПАЛ:', error?.code ?? '', error?.message ?? error);
  }
  app.exit(code);
});
