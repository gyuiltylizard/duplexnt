import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Конфиг установщика (B-29, U2): полный набор fuses и целостность asar. Fuse, выпавший из
// конфига, не ломает ни сборку, ни запуск — его отсутствие заметно только на чужой машине,
// поэтому набор держит тест. Разбор нарочно узкий: блок `electronFuses` — плоский список
// `ключ: булево` с двухпробельным отступом, YAML-библиотека для этого не нужна.

const CONFIG = readFileSync('electron-builder.yml', 'utf8');

/** Пары `ключ: значение` первого уровня вложенности внутри блока `name:`; комментарии — мимо. */
function block(name: string): Map<string, string> {
  const lines = CONFIG.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${name}:`);
  expect(start, `блок ${name} в конфиге`).toBeGreaterThanOrEqual(0);
  const result = new Map<string, string>();
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }
    if (!line.startsWith('  ')) {
      break;
    }
    const match = /^ {2}([A-Za-z0-9]+): (.+)$/.exec(line);
    expect(match, `строка блока ${name}: ${line}`).not.toBeNull();
    result.set(match?.[1] ?? '', match?.[2] ?? '');
  }
  return result;
}

/** Строки конфига без комментариев — для проверок «ключа нет нигде». */
const CODE = CONFIG.split(/\r?\n/)
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

describe('electron-builder.yml — fuses', () => {
  it('задаёт ровно ожидаемый набор fuses с нужными значениями', () => {
    expect(Object.fromEntries(block('electronFuses'))).toEqual({
      runAsNode: 'false',
      enableNodeOptionsEnvironmentVariable: 'false',
      enableNodeCliInspectArguments: 'false',
      onlyLoadAppFromAsar: 'true',
      enableCookieEncryption: 'true',
      enableEmbeddedAsarIntegrityValidation: 'true',
      grantFileProtocolExtraPrivileges: 'false',
    });
  });

  it('блок fuses один', () => {
    expect(CODE.match(/^electronFuses:/gm)).toHaveLength(1);
  });
});

describe('electron-builder.yml — asar', () => {
  it('приложение в asar, проверка целостности не отключена', () => {
    expect(CODE).toMatch(/^asar: true$/m);
    expect(CODE).not.toContain('disableAsarIntegrity');
  });

  it('sharp распакован — нативные модули из asar не грузятся', () => {
    const unpack = CODE.slice(CODE.indexOf('asarUnpack:'));
    expect(unpack).toContain('- node_modules/sharp/**');
    expect(unpack).toContain('- node_modules/@img/**');
  });
});
