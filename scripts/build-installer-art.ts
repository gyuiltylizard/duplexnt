// Графика установщика (B-26, handoff installer-art): SVG-мастера → build/installer-sidebar.bmp
// (164 × 314, страницы «Добро пожаловать» / «Готово» установщика и деинсталлятора) и
// build/installer-header.bmp (150 × 57, шапка остальных страниц). Запуск из корня:
// `npm run installer-art`. Результат коммитится — сборка от генерации не зависит (как значки).
//
// Без ресэмплинга: 1 ед. SVG = 1 px, растр ровно в размере viewBox. BMP без альфы — мастер
// NSIS её не понимает: прозрачное ложится на белый (`flatten`), в шапке это и есть фон.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { encodeBmp24, INSTALLER_ART } from './bmp.ts';

for (const art of INSTALLER_ART) {
  const { data, info } = await sharp(readFileSync(resolve(art.svg)))
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== art.width || info.height !== art.height || info.channels !== 3) {
    throw new Error(
      `${art.svg}: вышло ${String(info.width)}×${String(info.height)}×${String(info.channels)}, ждали ${String(art.width)}×${String(art.height)}×3`,
    );
  }
  writeFileSync(
    resolve(art.bmp),
    encodeBmp24({ width: info.width, height: info.height, rgb: new Uint8Array(data) }),
  );
  console.log(`${art.bmp}: ${String(art.width)}×${String(art.height)}, 24 бит`);
}
