import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Витрина репозитория (B-40, U5): формы Issues, CONTRIBUTING и README. Проверки текстовые, без
// YAML-библиотеки: форма без `name`/`description`/`body` на GitHub молча не появляется, а
// предупреждение о личных данных должно стоять раньше поля вложений.

const TEMPLATES = join('.github', 'ISSUE_TEMPLATE');
const read = (file: string): string => readFileSync(file, 'utf8');

const REPO = 'https://github.com/gyuiltylizard/duplexnt';
const PAGES = 'https://gyuiltylizard.github.io/duplexnt/';

describe('.github/ISSUE_TEMPLATE (B-40)', () => {
  it.each(['bug.yml', 'suggestion.yml'])('%s — форма с name, description и body', (file) => {
    const text = read(join(TEMPLATES, file));
    const name = /^name: (.+)$/m.exec(text)?.[1] ?? '';
    expect(name.length).toBeGreaterThan(3);
    expect(text).toMatch(/^description: .+$/m);
    expect(text).toMatch(/^body:$/m);
    expect(text).toContain('English or Russian');
  });

  it('bug.yml — предупреждение о личных данных стоит перед полем вложений', () => {
    const text = read(join(TEMPLATES, 'bug.yml'));
    const warning = text.indexOf('Do not attach scans of real documents');
    const attachments = text.indexOf('id: attachments');
    expect(warning).toBeGreaterThan(0);
    expect(attachments).toBeGreaterThan(warning);
    expect(text).toContain('192.0.2.10');
  });

  it('config.yml — пустые Issues выключены, ссылки на лендинг и приватный репорт уязвимости', () => {
    const text = read(join(TEMPLATES, 'config.yml'));
    expect(text).toMatch(/^blank_issues_enabled: false$/m);
    expect(text).toContain(PAGES);
    expect(text).toContain(`${REPO}/security/advisories/new`);
  });
});

describe('CONTRIBUTING.md (B-40)', () => {
  const text = read('CONTRIBUTING.md');

  it('говорит, что PR не принимаются, а вклад — через Issues; предупреждает о личных данных', () => {
    expect(text).toContain('does not accept unsolicited pull requests');
    expect(text).toContain(`${REPO}/issues`);
    expect(text).toMatch(/Do not attach scans of real\s+documents/);
  });
});

describe('README.md и README.ru.md (B-40)', () => {
  const en = read('README.md');
  const ru = read('README.ru.md');

  it('перекрёстные ссылки, адрес Pages, страница релизов, лицензия и имя', () => {
    expect(en).toContain('](README.ru.md)');
    expect(ru).toContain('](README.md)');
    for (const text of [en, ru]) {
      expect(text).toContain(PAGES);
      expect(text).toContain(`${REPO}/releases`);
      expect(text).toContain('GPL-3.0-only');
      expect(text).toContain('THIRD-PARTY-NOTICES.txt');
      expect(text).toContain('SHA256SUMS.txt');
      expect(text).toContain('SmartScreen');
    }
  });

  it('без устаревшего: каркас M0, «не публикуется», прямые ссылки на exe', () => {
    for (const text of [en, ru]) {
      expect(text).not.toMatch(/каркас \(веха M0\)|M0\)/);
      expect(text).not.toContain('не публикуется');
      expect(text).not.toMatch(/\]\([^)]*\.exe\)/);
    }
  });
});
