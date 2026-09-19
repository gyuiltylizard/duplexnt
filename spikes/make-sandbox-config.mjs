// Генерирует рабочий конфиг Windows Sandbox из шаблона: подставляет абсолютный путь release/.
// В Sandbox уезжает отдельный каталог только с установщиком — без win-unpacked и прочего.
// Запуск из корня репозитория: node spikes/make-sandbox-config.mjs
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const release = resolve('release');
const installers = readdirSync(release).filter((name) => name.endsWith('-setup.exe'));
if (installers.length !== 1) {
  throw new Error(`Ожидается ровно один установщик в release/, найдено: ${installers.length}`);
}
const [installer] = installers;

const shared = join(release, 'sandbox-share');
rmSync(shared, { recursive: true, force: true });
mkdirSync(shared);
copyFileSync(join(release, installer), join(shared, installer));

const template = readFileSync(resolve('spikes/sandbox.template.wsb'), 'utf8');
const config = join(release, 'duplexnt-sandbox.wsb');
writeFileSync(config, template.replace('{{RELEASE_DIR}}', shared));

console.log(`Установщик: ${join(shared, installer)}`);
console.log(`Конфиг Sandbox: ${config}`);
console.log('Дальше — двойной щелчок по конфигу в Проводнике.');
