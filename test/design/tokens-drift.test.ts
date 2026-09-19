import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DESIGN_SYSTEM_PATH,
  TOKENS_CSS_PATH,
  describeDrift,
  extractRootBlock,
  parseCustomProperties,
} from '../../scripts/design-tokens';

// Источник правды по токенам — блок `:root` в дизайн-системе. CSS — его копия.
// Сравниваются разобранные пары «имя — значение», а не текст: форматирование не дрейф.
const designSystem = readFileSync(resolve(DESIGN_SYSTEM_PATH), 'utf8');
const tokensCss = readFileSync(resolve(TOKENS_CSS_PATH), 'utf8');

describe('дрейф токенов', () => {
  it('файл токенов совпадает с блоком :root дизайн-системы по именам и значениям', () => {
    const expected = parseCustomProperties(extractRootBlock(designSystem));
    const actual = parseCustomProperties(tokensCss);

    expect(expected.size).toBeGreaterThan(100);
    expect(describeDrift(expected, actual)).toEqual([]);
  });
});

describe('разбор токенов', () => {
  it('разное форматирование одного значения — не расхождение', () => {
    const compact = parseCustomProperties(
      ':root{--shadow:0 1px 2px rgba(0,0,0,.2),0 0 0 1px red;--x:1px}',
    );
    const pretty = parseCustomProperties(`
      :root {
        /* комментарий со --словом: и точкой с запятой; */
        --shadow:
          0 1px 2px rgba(0, 0, 0, .2),
          0 0 0 1px red;
        --x:   1px;
      }
    `);

    expect(describeDrift(compact, pretty)).toEqual([]);
  });

  it('при расхождении называет токен и говорит править CSS', () => {
    const expected = parseCustomProperties(':root { --color-accent: #111; --space-1: 2px; }');
    const actual = parseCustomProperties(':root { --color-accent: #222; --space-99: 1px; }');

    const drift = describeDrift(expected, actual);

    expect(drift).toHaveLength(3);
    expect(drift.join('\n')).toContain('--color-accent');
    expect(drift.join('\n')).toContain('#111');
    expect(drift.join('\n')).toContain('--space-1');
    expect(drift.join('\n')).toContain('--space-99');
    for (const line of drift) {
      expect(line).toContain('tokens.css');
    }
  });

  it('не находит блок :root — падает внятно', () => {
    expect(() => extractRootBlock('# документ без блока')).toThrow(/:root/);
  });
});
