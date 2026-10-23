import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { expect, it } from 'vitest';
import { openPassService } from '../../src/core/scan/pass-service';
import { describeLive, probeLive, startPassWhenPaper } from '../support/live-device';
import { makeTempDataRoot } from '../support/temp-data-root';
import { unwrap } from '../support/result';
import { untilScored } from '../support/until';

// «Один лист после двух проходов» на живом устройстве (план M3.5, U8; AE12 — выход вехи):
// двусторонняя пачка → два прохода → один лист ОБОРОТОМ ВВЕРХ, развёрнутый на 180° (инструкция
// карточки «Один лист» в модалке `add`) → добавленный набор после лица последнего листа → PDF.
// Запуск — только по явному согласию:
//
//   PowerShell:  $env:DUPLEXNT_SCANNER_HOST = '<адрес сканера>'
//                npx vitest run --project integration test/integration/add-pages.live.test.ts
//
// Перед запуском пачка (2+ листа) лежит в лотке ЛИЦОМ ВВЕРХ, лист 1 сверху. После первого
// прохода тест ждёт: разверни пачку на 180° в плоскости и положи обратно — второй проход
// стартует сам. После второго прохода тест ждёт ещё раз: положи ОДИН лист оборотом вверх,
// развёрнутым на 180° (как лежала пачка на втором проходе), — добавленный проход стартует сам.
// Итоговый PDF — temp/duplexnt-live-add-one-sheet.pdf (занятое имя → суффикс « (2)», путь
// печатается в конце). Ориентация последней страницы сверяется ГЛАЗАМИ: это и есть открытый
// вопрос handoff'а (R25) — результат записывается в duplexnt-tech.md.
//
// Адрес сканера в вывод не попадает: он идентифицирует сеть автора.

const TIMEOUT_MS = 20 * 60_000;

describeLive('один лист после двух проходов на живом сканере (AE12)', (host) => {
  it(
    'пачка → два прохода → один лист оборотом вверх → PDF с добавленной страницей в конце',
    async () => {
      const root = await makeTempDataRoot();
      const service = await openPassService(root);
      await service.useScanner(await probeLive(host));

      console.info('[live] проход 1: лицевые стороны — пачка лицом вверх, лист 1 сверху');
      const fronts = unwrap(await service.startPass(null));
      expect(fronts.end).toBe('completed');
      expect(fronts.pages).toBeGreaterThanOrEqual(2);
      console.info(
        `[live] лицевые готовы: ${fronts.pages} листов. Разверни пачку на 180° в плоскости ` +
          '(не переворачивая листы) и положи в лоток — второй проход стартует сам.',
      );
      const backs = await startPassWhenPaper(service, null);
      expect(backs.end).toBe('completed');
      expect(backs.pages).toBe(fronts.pages);

      // Якорь — лицо последнего листа: набор встанет перед его оборотом, в конце документа —
      // после последней видимой страницы (KTD-8) он же, когда лист один.
      const order = service.snapshot().assembly?.order ?? [];
      const lastFront = order.filter((page) => page.side === 'front').at(-1);
      if (lastFront === undefined) {
        throw new Error('нет лицевых страниц');
      }
      console.info(
        '[live] обороты готовы. Положи ОДИН лист оборотом вверх, развёрнутым на 180° ' +
          '(как лежала пачка на втором проходе), — добавленный проход стартует сам.',
      );
      const added = await startPassWhenPaper(service, { kind: 'added', after: lastFront.key });
      expect(added.end).toBe('completed');
      expect(added.pages).toBe(1);

      const snapshot = service.snapshot();
      expect(snapshot.session?.passes.map((pass) => pass.kind)).toEqual([
        'fronts',
        'backs',
        'added',
      ]);
      const addedPage = snapshot.assembly?.order.find((page) => page.addedSet === 1);
      expect(addedPage).toBeDefined();
      expect(snapshot.assembly?.report).toMatchObject({ mismatch: false });

      const outDir = resolve('temp');
      await mkdir(outDir, { recursive: true });
      await untilScored(() => service.snapshot());
      const saved = unwrap(
        await service.saveDocuments(outDir, {
          mode: 'single',
          names: ['duplexnt-live-add-one-sheet'],
          retry: false,
        }),
      );
      expect(saved.failed).toEqual([]);
      const target = resolve(outDir, saved.written[0]?.fileName ?? '');
      const document = await PDFDocument.load(await readFile(target));
      expect(document.getPageCount()).toBe(fronts.pages * 2 + 1);

      const position =
        (snapshot.assembly?.order.findIndex((page) => page.addedSet === 1) ?? -1) + 1;
      console.info(
        `[live] PDF сохранён: ${target} (${fronts.pages * 2 + 1} страниц). ` +
          `Добавленная страница — №${position}. Открой файл и сверь: страница прямая? ` +
          'Если вверх ногами — инструкция карточки «Один лист» неверна, запиши в duplexnt-tech.md.',
      );
    },
    TIMEOUT_MS,
  );
});
