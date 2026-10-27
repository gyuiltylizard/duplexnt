import { describe, expect, it } from 'vitest';
import { encodeDevCssUrls } from '../../tooling/dev-css-urls';

// Шрифты под dev-сервером (fix/dev-fonts): апостроф в пути проекта ломал `url()` без кавычек.

describe('encodeDevCssUrls', () => {
  it('апостроф в пути `/@fs/` кодируется как %27 — и в woff2, и в woff', () => {
    const code =
      "src: url(/@fs/X:/repo/Duplexn't/node_modules/a.woff2) format('woff2'), " +
      "url(/@fs/X:/repo/Duplexn't/node_modules/a.woff) format('woff')";

    expect(encodeDevCssUrls(code)).toBe(
      "src: url(/@fs/X:/repo/Duplexn%27t/node_modules/a.woff2) format('woff2'), " +
        "url(/@fs/X:/repo/Duplexn%27t/node_modules/a.woff) format('woff')",
    );
  });

  it("кавычки вне адреса (`format('woff2')`) и адреса не из `/@fs/` не трогаются", () => {
    const code = "url(./files/a.woff2) format('woff2'); content: 'x'; url(/assets/b'c.png)";

    expect(encodeDevCssUrls(code)).toBe(code);
  });
});
