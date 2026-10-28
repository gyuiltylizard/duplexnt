import { describe, expect, it } from 'vitest';
import { skewProfileOf, type SkewProfile } from '@shared';
import { analyzeGrayGrid } from '../../../test/support/grid-analysis';
import {
  A4_HEIGHT_MM,
  fullLineNear,
  lineEndsAt,
  stepTheta,
  syntheticGray,
  WORKING_HEIGHT,
  WORKING_WIDTH,
  type SyntheticContent,
  type ThetaOf,
} from '../../../test/support/synthetic-page';
import { measureSkew } from '../detect/skew';
import {
  LATERAL_K,
  rawPaperWhite,
  STRAIGHT_SIZE_RATIO,
  STRAIGHTEN_ENCODING,
  straightenRaw,
  WARP_BAND_PIXELS,
  type RawImage,
} from './straighten';

// Чистая часть ресэмплера (план M6, U3) на синтетике рабочего размера: round-trip «искажение
// известным профилем с поворотом листа целиком → коррекция → остаток», нулевой профиль,
// заливка краёв, каналы, чанки и отмена. Декод и кодирование через `sharp`, настоящие сканы и
// worst-case — `test/integration/straighten*.test.ts`.

const immediate = () => Promise.resolve();

/** Профиль узлами, повторяющий θ(u) густо: сплайн между узлами — ошибка ниже допуска. */
function denseProfile(theta: ThetaOf, knots = 60): SkewProfile {
  return skewProfileOf(
    Array.from({ length: knots }, (_, i) => {
      const u = (i + 0.5) / knots;
      return { u, theta: theta(u) };
    }),
  );
}

const PX_PER_MM = WORKING_HEIGHT / A4_HEIGHT_MM;
/** 0,05° на плече между концами полной строки (170 мм), пиксели. */
const TOLERANCE_PX = 170 * PX_PER_MM * Math.tan((0.05 * Math.PI) / 180);

const STEP = stepTheta(0.2, -0.8, 0.55, 0.14);

function rawOf(gray: ReturnType<typeof syntheticGray>): RawImage {
  return { ...gray, channels: 1 };
}

async function straightened(theta: ThetaOf, content: SyntheticContent = 'text') {
  const distorted = syntheticGray({ theta, lateral: true, content });
  const out = await straightenRaw(rawOf(distorted), denseProfile(theta), {
    yieldBetween: immediate,
  });
  return { distorted, out: { data: out, width: distorted.width, height: distorted.height } };
}

describe('ресэмплер: round-trip на синтетике с поворотом листа целиком', () => {
  it('ступень 0,2° → −0,8°: после коррекции концы полных строк на одной высоте в допуске 0,05°', async () => {
    const { distorted, out } = await straightened(STEP);
    let checked = 0;
    for (let line = 2; line < 54; line += 5) {
      const index = fullLineNear(line);
      const before = lineEndsAt(distorted, index);
      const after = lineEndsAt(out, index);
      expect(after, `строка ${index}`).not.toBeNull();
      if (before === null || after === null) {
        continue;
      }
      expect(Math.abs(after.right - after.left), `строка ${index}`).toBeLessThanOrEqual(
        TOLERANCE_PX,
      );
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });

  it('сетка: после коррекции горизонтали и вертикали в допуске 0,05°, веер гасится', async () => {
    const { distorted, out } = await straightened(STEP, 'grid');
    const dpi = (WORKING_HEIGHT / A4_HEIGHT_MM) * 25.4;
    const before = analyzeGrayGrid(distorted, dpi);
    const after = analyzeGrayGrid(out, dpi);
    expect(before.horizontals.length).toBeGreaterThanOrEqual(15);
    expect(after.horizontals.length).toBeGreaterThanOrEqual(15);
    expect(after.verticals.length).toBeGreaterThanOrEqual(10);
    expect(before.fanMm).toBeGreaterThan(2);
    for (const h of after.horizontals) {
      expect(Math.abs(h.theta), `горизонталь u=${h.u.toFixed(2)}`).toBeLessThanOrEqual(0.05);
    }
    for (const v of after.verticals) {
      expect(Math.abs(v.tilt), `вертикаль x=${v.xMm.toFixed(0)} мм`).toBeLessThanOrEqual(0.05);
      expect(v.bowMm, `изгиб вертикали x=${v.xMm.toFixed(0)} мм`).toBeLessThanOrEqual(0.2);
    }
    expect(after.fanMm).toBeLessThanOrEqual(0.2);
  });

  it('выправленная страница измеряется детектором как ровная', async () => {
    const { out } = await straightened(STEP);
    const result = await measureSkew(out, { yieldBetween: immediate });
    expect(result.outcome).toBe('level');
  });

  it('нулевой профиль — выход равен входу байт в байт; вход не меняется', async () => {
    const gray = syntheticGray({ theta: () => 0 });
    const copy = Uint8Array.from(gray.data);
    const out = await straightenRaw(rawOf(gray), skewProfileOf([{ u: 0.5, theta: 0 }]), {
      yieldBetween: immediate,
    });
    expect(Buffer.from(out).equals(Buffer.from(gray.data))).toBe(true);
    expect(Buffer.from(gray.data).equals(Buffer.from(copy))).toBe(true);
  });
});

describe('ресэмплер: края, каналы, чанки', () => {
  it('углы после сдвига залиты белым бумаги (кремовым), не чёрным и не 255', async () => {
    // Без шума бумага — ровно один уровень; наклон 1,5° уводит углы за кромку.
    const gray = syntheticGray({ theta: () => 1.5, noise: 0 });
    const raw = rawOf(gray);
    const [white] = rawPaperWhite(raw);
    expect(white).toBeGreaterThan(150);
    expect(white).toBeLessThan(255);
    const out = await straightenRaw(raw, skewProfileOf([{ u: 0.5, theta: 1.5 }]), {
      yieldBetween: immediate,
    });
    const { width, height } = gray;
    // При θ > 0 правый конец строки выше: y_src = y − (x − xc)·tanθ — внизу справа источник
    // ниже кромки, вверху слева — выше.
    const corners = [0, (height - 1) * width + width - 1];
    for (const corner of corners) {
      expect(out[corner]).toBe(white);
    }
  });

  it('три канала: сдвиг одинаков по каналам, постоянные смещения каналов сохраняются', async () => {
    const gray = syntheticGray({ theta: STEP, lateral: true, noise: 0 });
    const { width, height } = gray;
    const data = new Uint8Array(width * height * 3);
    for (let i = 0; i < gray.data.length; i += 1) {
      // Запас сверху: выброс Catmull-Rom у кромки штриха не должен упереться в 255.
      const g = Math.round((gray.data[i] ?? 0) * 0.8);
      data[i * 3] = g;
      data[i * 3 + 1] = g + 3;
      data[i * 3 + 2] = g + 6;
    }
    const out = await straightenRaw({ data, width, height, channels: 3 }, denseProfile(STEP), {
      yieldBetween: immediate,
    });
    const single = await straightenRaw(
      { data: data.filter((_, i) => i % 3 === 0), width, height, channels: 1 },
      denseProfile(STEP),
      { yieldBetween: immediate },
    );
    for (let i = 0; i < width * height; i += width * 7 + 13) {
      expect(out[i * 3], `пиксель ${i}`).toBe(single[i]);
      expect(out[i * 3 + 1], `пиксель ${i}`).toBe((single[i] ?? 0) + 3);
      expect(out[i * 3 + 2], `пиксель ${i}`).toBe((single[i] ?? 0) + 6);
    }
  });

  it('полосы по бюджету пикселей: чанков столько, сколько полос; точка уступки — после каждой', async () => {
    const gray = syntheticGray({ theta: STEP });
    const chunks: number[] = [];
    let yields = 0;
    await straightenRaw(rawOf(gray), denseProfile(STEP), {
      bandPixels: WORKING_WIDTH * 100,
      onChunk: (ms) => {
        chunks.push(ms);
      },
      yieldBetween: () => {
        yields += 1;
        return Promise.resolve();
      },
    });
    expect(chunks.length).toBe(Math.ceil(WORKING_HEIGHT / 100));
    expect(yields).toBe(chunks.length);
  });

  it('отмена между полосами: промис отклоняется причиной сигнала, дальше полосы не считаются', async () => {
    const gray = syntheticGray({ theta: STEP });
    const controller = new AbortController();
    let chunks = 0;
    const run = straightenRaw(rawOf(gray), denseProfile(STEP), {
      bandPixels: WORKING_WIDTH * 100,
      signal: controller.signal,
      onChunk: () => {
        chunks += 1;
        if (chunks === 3) {
          controller.abort(new Error('стоп'));
        }
      },
      yieldBetween: immediate,
    });
    await expect(run).rejects.toThrow('стоп');
    expect(chunks).toBe(3);
  });

  it('константы: бюджет полосы 0,5 Мпикс, дрейф полный, кодирование q92 4:4:4, запас размера', () => {
    expect(WARP_BAND_PIXELS).toBe(500_000);
    expect(LATERAL_K).toBe(1);
    expect(STRAIGHTEN_ENCODING).toBe('jpeg-q92-444');
    expect(STRAIGHT_SIZE_RATIO).toBeGreaterThanOrEqual(1);
  });
});
