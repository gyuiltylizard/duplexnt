import { describe, expect, it } from 'vitest';
import type { PassServiceOptions } from '../../src/core/scan/pass-service';
import { openSettingsStore } from '../../src/core/storage/settings-store';
import { connectService, scanned, FAST_JOB_LIMITS } from '../support/pass-service';
import { unwrap } from '../support/result';
import { journalOnDisk } from '../support/session-store';

// Проводка режима выравнивания из настроек в сессию на настоящей цепочке (план M6, U4; R14, R15;
// ADR 0004, амендмент 2026-10-28): эмулятор → служба → `beginPass` с режимом из настроек →
// журнал v8. Режим замораживается при открытии сессии: смена настройки после меняет снимок, но
// не сессию; новая сессия берёт уже новое значение. Ревью сессий 1–2 (находка #2): четвёртый
// аргумент `beginPass` — единственная связь настройки с сессией, и обрыв его тихо выключил бы
// выравнивание у всех сессий (дефолт хранилища — `off`).

const OPTIONS = {
  jobLimits: FAST_JOB_LIMITS,
  minFreeBytes: 1,
  retry: { ceilingMs: 0 },
} satisfies PassServiceOptions;

describe('служба прохода: режим выравнивания сессии (M6, U4)', () => {
  it('без файла настроек сессия открывается в «выравнивать»; смена настройки не трогает открытую сессию, новая берёт новое', async () => {
    const { root, service, restart } = await connectService(
      {
        trays: [
          [1, 2],
          [3, 4],
          [5, 6],
        ],
      },
      OPTIONS,
    );
    expect(service.snapshot().straightenMode).toBe('auto');

    await scanned(service, 2);

    expect(service.snapshot().session?.straighten).toBe('auto');
    expect((await journalOnDisk(root)).straighten).toBe('auto');

    unwrap(await (await openSettingsStore(root)).setStraightenMode('off'));
    const again = await restart();
    expect(again.snapshot().straightenMode).toBe('off');
    expect(again.snapshot().session?.straighten).toBe('auto');

    // Второй проход (обороты) идёт в ту же сессию: режим заморожен при её открытии.
    await scanned(again, 2);
    expect(again.snapshot().session?.straighten).toBe('auto');
    expect((await journalOnDisk(root)).straighten).toBe('auto');

    // «Новое сканирование» под настройкой «не выравнивать» — сессия `off`.
    unwrap(await again.closeSession());
    await scanned(again, 2);
    expect(again.snapshot().session?.straighten).toBe('off');
    expect((await journalOnDisk(root)).straighten).toBe('off');
  });
});
