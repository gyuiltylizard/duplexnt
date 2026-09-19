import { describe, expect, it } from 'vitest';
import { buildCsp, parseCsp } from './csp';

const DEV_ORIGIN = 'http://localhost:5173';

describe('buildCsp — сборочный профиль', () => {
  const csp = buildCsp({ profile: 'build' });
  const directives = parseCsp(csp);

  it("начинается с default-src 'none'", () => {
    expect(csp.startsWith("default-src 'none'")).toBe(true);
  });

  it("разрешает скрипты, стили и шрифты только с 'self'", () => {
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(directives.get('style-src')).toEqual(["'self'"]);
    expect(directives.get('font-src')).toEqual(["'self'"]);
  });

  it('закрывает base-uri, form-action и object-src отдельно — default-src их не покрывает', () => {
    expect(directives.get('base-uri')).toEqual(["'none'"]);
    expect(directives.get('form-action')).toEqual(["'none'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
  });

  it('не содержит ослаблений и сетевых источников', () => {
    expect(csp).not.toContain('unsafe-eval');
    expect(directives.get('script-src')).not.toContain("'unsafe-inline'");
    for (const forbidden of ['ws:', 'http:', 'https:', 'localhost', '*']) {
      expect(csp).not.toContain(forbidden);
    }
  });
});

describe('buildCsp — профиль разработки', () => {
  const build = parseCsp(buildCsp({ profile: 'build' }));
  const dev = parseCsp(buildCsp({ profile: 'dev', devServerOrigin: DEV_ORIGIN }));

  it('отличается от сборочного только источниками для HMR', () => {
    const hmrOnly = new Set(["'unsafe-inline'", DEV_ORIGIN, 'ws://localhost:5173']);

    for (const [name, buildSources] of build) {
      const devSources = dev.get(name);
      expect(devSources, `директива ${name} пропала в dev`).toBeDefined();
      const meaningful = buildSources.filter((source) => source !== "'none'");
      for (const source of meaningful) {
        expect(devSources).toContain(source);
      }
    }
    for (const [name, devSources] of dev) {
      const buildSources = build.get(name) ?? [];
      const extra = devSources.filter(
        (source) => source !== "'none'" && !buildSources.includes(source),
      );
      for (const source of extra) {
        expect(hmrOnly.has(source), `${name}: лишний источник ${source}`).toBe(true);
      }
    }
  });

  it('и в разработке не разрешает unsafe-eval', () => {
    expect(buildCsp({ profile: 'dev', devServerOrigin: DEV_ORIGIN })).not.toContain('unsafe-eval');
  });

  it('отклоняет origin dev-сервера не с localhost', () => {
    expect(() => buildCsp({ profile: 'dev', devServerOrigin: 'http://192.0.2.10:5173' })).toThrow(
      TypeError,
    );
    expect(() => buildCsp({ profile: 'dev', devServerOrigin: 'не url' })).toThrow(TypeError);
  });
});
