// Переносит блок `:root` из дизайн-системы в файл токенов renderer — целиком, без правки
// значений. Запуск из корня: `npm run tokens:sync`. Дрейф между ними ловит тест
// test/design/tokens-drift.test.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DESIGN_SYSTEM_PATH, TOKENS_CSS_PATH, extractRootBlock } from './design-tokens.ts';

const header = `/*
 * Токены дизайн-системы. СГЕНЕРИРОВАНО из блока \`:root\` в ${DESIGN_SYSTEM_PATH} —
 * источник правды там. Руками не править: \`npm run tokens:sync\`.
 * Расхождение с документом ловит test/design/tokens-drift.test.ts.
 */
`;

const block = extractRootBlock(readFileSync(resolve(DESIGN_SYSTEM_PATH), 'utf8'));
writeFileSync(resolve(TOKENS_CSS_PATH), `${header}${block}\n`);
console.log(`${TOKENS_CSS_PATH} обновлён из ${DESIGN_SYSTEM_PATH}`);
