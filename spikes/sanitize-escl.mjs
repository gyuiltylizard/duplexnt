// Зачистка сырых ответов eSCL перед тем, как они станут фикстурами (план M0, U9, KTD-22).
// Вход — local-test-data/device/ (вне git), выход — test/fixtures/escl/<устройство>/.
// Запуск из корня: node spikes/sanitize-escl.mjs [устройство]
//
// Заменяется ТОЛЬКО то, что идентифицирует устройство и сеть; остальное — байт в байт, включая
// концы строк. Правила и плейсхолдеры — test/fixtures/README.md.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  PLACEHOLDER_IPV4,
  PLACEHOLDER_SERIAL,
  PLACEHOLDER_UUID,
} from '../scripts/privacy-guard.ts';

const device = process.argv[2] ?? 'et-3850';
const RAW = resolve('local-test-data/device');
const OUT = resolve('test/fixtures/escl', device);

function sanitize(xml) {
  const report = [];
  const replace = (pattern, replacement, label) => {
    let count = 0;
    // Замена — всегда функция от групп: строка с `$1` внутри колбэка не раскрывается.
    xml = xml.replace(pattern, (_match, ...groups) => {
      count += 1;
      return replacement(groups);
    });
    report.push(`${label}: ${count}`);
  };

  // Секция заданий — история конкретного устройства с UUID заданий: вырезается целиком,
  // вместе с отступом и переводом строки перед ней.
  replace(/[ \t]*<scan:Jobs>[\s\S]*?<\/scan:Jobs>\r?\n?/g, () => '', 'секций заданий вырезано');
  replace(
    /(<scan:UUID>)[^<]*(<\/scan:UUID>)/g,
    ([open, close]) => `${open}${PLACEHOLDER_UUID}${close}`,
    'UUID устройства',
  );
  replace(
    /(<pwg:SerialNumber>)[^<]*(<\/pwg:SerialNumber>)/g,
    ([open, close]) => `${open}${PLACEHOLDER_SERIAL}${close}`,
    'серийный номер',
  );
  // Хост во ВСЕХ URI ответа: административная ссылка, иконка и любые другие.
  replace(
    /(<(?:\w+:)?\w*UR[IL]\w*>\s*https?:\/\/)[^/<\s]+/gi,
    ([prefix]) => `${prefix}${PLACEHOLDER_IPV4}`,
    'хост в URI',
  );
  return { xml, report };
}

mkdirSync(OUT, { recursive: true });
for (const name of ['ScannerCapabilities.xml', 'ScannerStatus.xml']) {
  // latin1 сохраняет байты один к одному: содержимое вне заменяемых мест не перекодируется.
  const { xml, report } = sanitize(readFileSync(join(RAW, name), 'latin1'));
  writeFileSync(join(OUT, name), xml, 'latin1');
  console.log(`${name} → ${report.join('; ')}`);
}
console.log('Дальше: node scripts/privacy-guard.ts — страж обязан быть зелёным.');
