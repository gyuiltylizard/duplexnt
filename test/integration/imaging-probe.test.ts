import { describe, expect, it, vi } from 'vitest';
import { handleProbe } from '../../src/core/probe/handle-probe';
import { imagingProbe } from '../../src/core/probe/imaging-probe';

// Интеграционный прогон: настоящий `sharp` под обычным Node, без electron-as-node —
// prebuilt N-API ABI-стабилен между Node и Electron (план M0, KTD-12).
describe('imagingProbe', () => {
  it('возвращает версию libvips и размеры закодированного изображения', async () => {
    const result = await imagingProbe();

    expect(result.libvips).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.sharp).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.image).toMatchObject({ format: 'jpeg', width: 8, height: 8 });
    expect(result.image.bytes).toBeGreaterThan(0);
  });
});

describe('handleProbe целиком', () => {
  it('годный вход → эхо токена и версия libvips', async () => {
    const result = await handleProbe({ token: 'integration' });

    if (!result.ok) {
      throw new Error(`проба отказала: ${result.error.code}`);
    }
    expect(result.value.echo).toBe('integration');
    expect(result.value.versions.libvips).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.value.versions.node).toBe(process.versions.node);
    expect(result.value.versions.electron).toBeNull();
  });

  it('мусор на входе → отказ с кодом неверного входа, до sharp дело не доходит', async () => {
    const runImagingProbe = vi.fn(imagingProbe);

    await expect(handleProbe(42, runImagingProbe)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalidInput' },
    });
    await expect(handleProbe({ token: '' }, runImagingProbe)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalidInput', details: { field: 'token' } },
    });
    expect(runImagingProbe).not.toHaveBeenCalled();
  });
});
