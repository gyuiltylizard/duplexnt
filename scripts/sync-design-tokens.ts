// Переносит блок `:root` из дизайн-системы в файл токенов renderer — целиком, без правки
// значений. Запуск из корня: `npm run tokens:sync`. Дрейф между ними ловит тест
// test/design/tokens-drift.test.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractRootBlock } from './design-tokens.ts';

const SOURCE = 'docs/design/DESIGN_SYSTEM.md';
const TARGET = 'src/renderer/src/styles/tokens.css';

const header = `/*
 * Токены дизайн-системы. СГЕНЕРИРОВАНО из блока \`:root\` в ${SOURCE} —
 * источник правды там. Руками не править: \`npm run tokens:sync\`.
 * Расхождение с документом ловит test/design/tokens-drift.test.ts.
 */
`;

const block = extractRootBlock(readFileSync(resolve(SOURCE), 'utf8'));
writeFileSync(resolve(TARGET), `${header}${block}\n`);
console.log(`${TARGET} обновлён из ${SOURCE}`);
