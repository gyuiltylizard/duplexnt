import { existsSync, readFileSync } from 'node:fs';
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

describe('electron-builder.yml — графика мастера (B-26)', () => {
  it('три картинки nsis указывают на собранные BMP в build/', () => {
    const nsis = block('nsis');
    expect(nsis.get('installerSidebar')).toBe('build/installer-sidebar.bmp');
    expect(nsis.get('uninstallerSidebar')).toBe('build/installer-sidebar.bmp');
    expect(nsis.get('installerHeader')).toBe('build/installer-header.bmp');
    for (const file of new Set(
      ['installerSidebar', 'uninstallerSidebar', 'installerHeader'].map(
        (key) => nsis.get(key) ?? '',
      ),
    )) {
      expect(existsSync(file), `файл ${file}`).toBe(true);
    }
  });
});

describe('electron-builder.yml — вопрос о данных при удалении (B-26)', () => {
  const NSH = readFileSync('build/installer.nsh', 'utf8');

  it('включение подключено, встроенное удаление данных выключено, языки — en_US и ru_RU', () => {
    const nsis = block('nsis');
    expect(nsis.get('include')).toBe('build/installer.nsh');
    expect(nsis.get('deleteAppDataOnUninstall')).toBe('false');
    expect(nsis.get('installerLanguages')).toBe('[en_US, ru_RU]');
  });

  it('каждая строка включения переведена на оба языка установщика (makensis идёт с -WX)', () => {
    const ids = new Map<string, Set<number>>();
    for (const match of NSH.matchAll(/^LangString (\w+) (\d+) /gmu)) {
      const [, id, lcid] = match;
      ids.set(id ?? '', (ids.get(id ?? '') ?? new Set<number>()).add(Number(lcid)));
    }
    expect(ids.size).toBeGreaterThan(0);
    for (const [id, lcids] of ids) {
      expect([...lcids].sort(), `строка ${id}`).toEqual([1033, 1049]);
    }
  });

  it('удаление данных — только по галочке, своей секцией; страница после «Добро пожаловать»', () => {
    expect(NSH).toMatch(
      /!macro customUnInstall[\s\S]*\$deleteUserData == \$\{BST_CHECKED\}[\s\S]*RMDir \/r "\$APPDATA\\\$\{APP_FILENAME\}"/u,
    );
    expect(NSH).toMatch(
      /!macro customUnWelcomePage\n {2}!insertmacro MUI_UNPAGE_WELCOME\n {2}UninstPage custom/u,
    );
    expect(NSH).toMatch(/NSD_SetState\} \$deleteUserDataCheckbox \$\{BST_UNCHECKED\}/u);
  });
});

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

describe('electron-builder.yml — метаданные публичной сборки (B-40)', () => {
  it('копирайт задан явно', () => {
    expect(CODE).toMatch(/^copyright: Copyright © \d{4} gyuiltylizard$/m);
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
