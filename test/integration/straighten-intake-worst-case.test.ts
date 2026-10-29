import { monitorEventLoopDelay } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { inlineImageWorker } from '../../src/core/image/image-worker';
import type { PassServiceOptions } from '../../src/core/scan/pass-service';
import { SCENARIOS } from '../emulator/scenarios';
import { connectService, scanned } from '../support/pass-service';
import { unwrap } from '../support/result';
import { untilStraightened } from '../support/until';

// Приём страницы рядом с коррекцией (план M6, U9; ревью сессий 3–4, остаточный риск; ADR 0008):
// коррекция идёт мимо общего лимитера производного в том же процессе, что приём страницы, —
// шесть косых страниц 600 dpi (`fan-600`) с настоящим исполнителем. Проход с выравниванием
// обязан завершиться штатно при пределах устройства по умолчанию, а паузы цикла событий за
// проход — укладываться в пороги ADR 0008; длительность прохода против режима «не трогать» —
// цифра в журнал, не порог: на эмуляторе страница «едет» мгновенно, и всё время прохода — это
// декод и приём, а у живого сканера лист идёт ~10 с.

const STALL_MAX_MS = 100;
const STALL_P95_MS = 30;

const OPTIONS = {
  minFreeBytes: 1,
  retry: { ceilingMs: 0 },
} satisfies PassServiceOptions;

const SHEETS = SCENARIOS['fan-600'].trays[0].length;

describe('приём страницы рядом с коррекцией: худший объём (M6, U9)', () => {
  it(
    'fan-600: проход с выравниванием завершён штатно, паузы цикла max < 100 мс, p95 < 30 мс; длительность против «не трогать» — в журнал',
    { timeout: 300_000 },
    async () => {
      const off = await connectService(SCENARIOS['fan-600'], OPTIONS, {
        imageWorker: inlineImageWorker(),
      });
      unwrap(await off.service.setStraightenMode('off'));
      const offStarted = performance.now();
      await scanned(off.service, SHEETS);
      const offMs = performance.now() - offStarted;
      await off.service.settleDerived();

      const auto = await connectService(SCENARIOS['fan-600'], OPTIONS, {
        imageWorker: inlineImageWorker(),
      });
      const delay = monitorEventLoopDelay({ resolution: 5 });
      delay.enable();
      const autoStarted = performance.now();
      const pass = unwrap(await auto.service.startPass(null));
      const autoMs = performance.now() - autoStarted;
      expect(pass).toMatchObject({ end: 'completed', pages: SHEETS });
      // Страницы приняты; коррекция продолжается после прохода — ждём её, паузы считаются и тут.
      await untilStraightened(() => auto.service.snapshot());
      const doneMs = performance.now() - autoStarted;
      delay.disable();
      const stallMax = delay.max / 1e6;
      const stallP95 = delay.percentile(95) / 1e6;
      const summary = auto.service.snapshot().assembly?.straighten;
      console.info(
        `[U9 intake] ${String(SHEETS)} стр. 600 dpi серых: проход «не трогать» ${offMs.toFixed(0)} мс, ` +
          `с выравниванием ${autoMs.toFixed(0)} мс (×${(autoMs / offMs).toFixed(2)}), до конца коррекции ${doneMs.toFixed(0)} мс; ` +
          `выровнено ${String(summary?.straightened ?? 0)} из ${String(summary?.total ?? 0)}; паузы цикла max ${stallMax.toFixed(1)} мс, p95 ${stallP95.toFixed(1)} мс`,
      );
      expect(summary?.straightened).toBe(SHEETS);
      expect(stallMax).toBeLessThan(STALL_MAX_MS);
      expect(stallP95).toBeLessThan(STALL_P95_MS);
      await auto.service.settleDerived();
    },
  );
});
