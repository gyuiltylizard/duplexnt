import { describe, expect, it } from 'vitest';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import { openSettingsStore } from '../storage/settings-store';
import { openPassService } from './pass-service';

// Режимы службы прохода из настроек (M4, U3; M6, U4): режим пустых оборотов — команда службы,
// режим выравнивания — только в снимке (команды нет до U12). Проводка режима выравнивания в
// сессию через `beginPass` — test/integration/straighten-mode.emulator.test.ts. Выделено из
// `pass-service.test.ts` по правилу размера тестового файла.

describe('служба прохода: режим выравнивания (M6, U4)', () => {
  it('в снимке — из настроек: без файла «выравнивать», записанный режим помнится между открытиями', async () => {
    const root = await makeTempDataRoot();
    expect((await openPassService(root)).snapshot().straightenMode).toBe('auto');

    expect(await (await openSettingsStore(root)).setStraightenMode('off')).toEqual({
      ok: true,
      value: undefined,
    });

    expect((await openPassService(root)).snapshot().straightenMode).toBe('off');
  });
});

describe('служба прохода: режим пустых оборотов (M4, U3)', () => {
  it('принимается без сканера, уходит в снимок и помнится между открытиями службы', async () => {
    const root = await makeTempDataRoot();
    const service = await openPassService(root);
    const seqBefore = service.snapshot().seq;

    expect(service.snapshot().blankMode).toBe('hide');
    expect(await service.setBlankMode('keep')).toEqual({ ok: true, value: undefined });
    expect(service.snapshot().blankMode).toBe('keep');
    expect(service.snapshot().seq).toBeGreaterThan(seqBefore);

    expect((await openPassService(root)).snapshot().blankMode).toBe('keep');
  });
});
