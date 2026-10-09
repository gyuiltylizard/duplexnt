import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { expect, it } from 'vitest';
import { EMPTY_EDITS } from '@shared';
import { openPassService } from '../../src/core/scan/pass-service';
import { describeLive, probeLive, startPassWhenPaper } from '../support/live-device';
import { makeTempDataRoot } from '../support/temp-data-root';
import { unwrap } from '../support/result';

// Двухпроходный прогон на живом устройстве (план M2, U10; AE2 — выход вехи): двусторонняя
// пачка пронумерованных листов (spikes/make-twopass-pdf.mjs, 12 листов) → два прохода через
// службу → тумблер 180° → PDF. Запуск — только по явному согласию:
//
//   PowerShell:  $env:DUPLEXNT_SCANNER_HOST = '<адрес сканера>'
//                npx vitest run --project integration test/integration/two-pass.live.test.ts
//
// Перед запуском пачка лежит в лотке ЛИЦОМ ВВЕРХ, лист 1 сверху. После первого прохода тест
// ждёт: разверни пачку на 180° в плоскости (не переворачивая листы) и положи обратно — второй
// проход стартует сам, как только лоток перестанет быть пустым. Итоговый PDF кладётся в
// temp/duplexnt-live-two-pass.pdf (если имя занято прошлым прогоном — с суффиксом « (2)», путь
// печатается в конце) — порядок страниц сверяется глазами по номерам (AE2).
//
// Поворота оборотов в штатном потоке НЕТ: после разворота пачки они приходят в правильной
// ориентации (техбаза, «Физическое действие пользователя»; подтверждено живым прогоном
// 2026-10-05 — принудительный поворот в первой версии теста перевернул их вверх ногами).
// Тумблер 180° — аварийный; его механика (/Rotate в PDF) проверяется отдельным сохранением
// без пересканирования (AE8).
//
// Адрес сканера в вывод не попадает: он идентифицирует сеть автора.

// Страница при 300 dpi идёт до 26 с (журнал M1, U1): два прохода по 12 листов + окно на
// разворот пачки.
const TIMEOUT_MS = 20 * 60_000;

describeLive('два прохода на живом сканере (AE2)', (host) => {
  it(
    'пачка → два прохода → тумблер 180° → PDF в собранном порядке',
    async () => {
      const root = await makeTempDataRoot();
      const service = await openPassService(root);
      await service.useScanner(await probeLive(host));

      console.info('[live] проход 1: лицевые стороны — пачка лицом вверх, лист 1 сверху');
      const fronts = unwrap(await service.startPass(null));
      expect(fronts.end).toBe('completed');
      expect(fronts.pages).toBeGreaterThanOrEqual(2);
      console.info(
        `[live] лицевые готовы: ${fronts.pages} листов. ` +
          'Разверни пачку на 180° в плоскости (не переворачивая листы) и положи в лоток — ' +
          'второй проход стартует сам.',
      );

      // Второй проход: пока лоток пуст, устройство отвечает «нет бумаги» — ждём разворота.
      const backsReport = await startPassWhenPaper(service, null);
      expect(backsReport.end).toBe('completed');
      expect(backsReport.pages).toBe(fronts.pages);

      const report = service.snapshot().assembly?.report;
      expect(report).toMatchObject({
        fronts: fronts.pages,
        backs: fronts.pages,
        pairs: fronts.pages,
        mismatch: false,
      });

      // Штатный поток: пачка развёрнута правильно, обороты пришли в правильной ориентации —
      // тумблер НЕ включается, поворота в PDF нет.
      // Пакетное сохранение не перезаписывает файл прошлого прогона, а берёт имя с суффиксом
      // « (2)» — путь берётся из отчёта.
      const outDir = resolve('temp');
      await mkdir(outDir, { recursive: true });
      const saveOne = async (name: string): Promise<string> => {
        const saved = unwrap(
          await service.saveDocuments(outDir, { mode: 'single', names: [name], retry: false }),
        );
        expect(saved.failed).toEqual([]);
        expect(saved.written).toHaveLength(1);
        return resolve(outDir, saved.written[0]?.fileName ?? '');
      };
      const target = await saveOne('duplexnt-live-two-pass');

      const document = await PDFDocument.load(await readFile(target));
      expect(document.getPageCount()).toBe(fronts.pages * 2);
      for (const [index, page] of document.getPages().entries()) {
        expect(page.getRotation().angle, `страница ${index + 1}`).toBe(0);
      }
      expect(service.snapshot().session?.saved).toBe(true);

      // Исходники целы: порядок несёт обе стороны каждого листа.
      const order = service.snapshot().assembly?.order ?? [];
      expect(order).toHaveLength(fronts.pages * 2);

      // AE8/AE12 без пересканирования: аварийный тумблер снимает отметку сохранения и кладёт
      // /Rotate 180 только на обороты; выключение возвращает.
      unwrap(await service.setEdits(EMPTY_EDITS, true));
      expect(service.snapshot().session?.saved).toBe(false);
      const rotatedTarget = await saveOne('duplexnt-live-two-pass-rotated');
      const rotated = await PDFDocument.load(await readFile(rotatedTarget));
      for (const [index, page] of rotated.getPages().entries()) {
        expect(page.getRotation().angle, `страница ${index + 1}`).toBe(index % 2 === 1 ? 180 : 0);
      }
      unwrap(await service.setEdits(EMPTY_EDITS, false));

      console.info(
        `[live] PDF сохранён: ${target} (${fronts.pages * 2} страниц). ` +
          'Открой его и сверь порядок по номерам: 1 FRONT, 1 BACK, 2 FRONT, 2 BACK, … — ' +
          'все страницы должны быть прямыми, без поворота. ' +
          `Файл ${rotatedTarget} — проверка аварийного тумблера, там обороты нарочно вверх ногами.`,
      );
    },
    TIMEOUT_MS,
  );
});
