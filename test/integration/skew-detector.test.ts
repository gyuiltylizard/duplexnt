import { describe, expect, it } from 'vitest';
import { skewThetaAt, type SkewMeasure, type SkewOutcome } from '@shared';
import {
  BAND_MM,
  CONFIDENCE_MIN,
  FALLBACK_BAND_MM,
  IMPROVE_RATIO,
  MIN_BANDS,
  LEVEL_DEG,
  measureSkewJpeg,
  SHAPE_RESIDUAL_DENSE_MAX_DEG,
  SHAPE_RESIDUAL_MAX_DEG,
} from '../../src/core/detect/skew';
import { pageFixture, scanFixture, scanFixtureNames } from '../support/fixtures';
import { analyzeGrid, dpiOfScanName } from '../support/grid-analysis';
import { stepTheta, syntheticJpeg } from '../support/synthetic-page';

// Калибровка детектора перекоса на настоящих сканах ET-3850 (план M6, U2, R23, R24; техбаза
// → «Перекос подачи: спайк»). Таблица — ожидаемый исход по имени скана; тест печатает
// профили и метрики (цифры — в журнал вехи), проверяет класс каждого скана, запас по
// уверенности, бюджет чанков и согласие профиля с линиями сетки на полном разрешении.

/** Предел пикселей ET-3850 при 600 dpi на A4 с запасом — как в журнале прохода. */
const PIXEL_LIMIT = 5100 * 8400;

/**
 * Ожидаемые исходы. Косые листы с остановкой подачи (`fan-*`) выправляются (бедный лист —
 * прямой по двум узлам); ловушки для проекционного детектора — две колонки и косая штриховка
 * — либо выправляются с ростом контраста, либо остаются как есть, но никогда не портятся
 * (R24); фото, чистые листы, бледный карандаш, одна строка и подпись — «не по чему мерить».
 * Печатная страница детектора пустых (M4) тоже несёт ступень; с детектора v5 проходит основным
 * проходом 30 мм. Рабочая тетрадь автора (`fan-worksheet-*`) — графичная страница с шумом
 * соседних полос 0,1–0,2°: выправляется по мягкому порогу плотной опоры (журнал 0030).
 */
const EXPECTED: Readonly<Record<string, readonly SkewOutcome[]>> = {
  'fan-text-gray-300': ['willStraighten'],
  'fan-text-color-300': ['willStraighten'],
  'fan-text-gray-200': ['willStraighten'],
  'fan-text-gray-600': ['willStraighten'],
  'fan-table-gray-300': ['willStraighten'],
  'fan-grid-1-gray-300': ['willStraighten'],
  'fan-grid-2-gray-300': ['willStraighten'],
  'fan-grid-3-gray-300': ['willStraighten'],
  'tilt-grid-gray-300': ['willStraighten'],
  'fan-sparse-gray-300': ['willStraighten'],
  'fan-twocol-gray-300': ['willStraighten'],
  'fan-twocol-gray-200': ['willStraighten'],
  'fan-worksheet-color-200': ['willStraighten'],
  'fan-graphic-gray-300': ['willStraighten', 'notImproved', 'unmeasurable'],
  'photo-gray-300': ['unmeasurable'],
  'photo-color-300': ['unmeasurable'],
  'blank-gray-200': ['unmeasurable'],
  'blank-gray-300': ['unmeasurable'],
  'blank-gray-600': ['unmeasurable'],
  'blank-color-300': ['unmeasurable'],
  'bleed-gray-300': ['unmeasurable'],
  'punched-gray-300': ['unmeasurable'],
  'pencil-faint-gray-300': ['unmeasurable'],
  'pencil-faint-color-300': ['unmeasurable'],
  'pencil-number-gray-200': ['unmeasurable'],
  'signature-gray-300': ['unmeasurable'],
  'text-gray-300': ['willStraighten'],
  'text-line-gray-300': ['unmeasurable'],
  'sheet-front-gray-200': ['willStraighten'],
  'sheet-back-gray-200': ['willStraighten'],
  'rulers-gray-200': ['willStraighten'],
};

/**
 * Измеренные сканы, которые проходят только запасным проходом 50 мм: обычный проход 30 мм
 * проваливает гейт формы. Закреплено, чтобы запасной проход нельзя было убрать, оставив таблицу
 * зелёной; неизмеримые листы не закрепляются — у них 50 означает лишь провал формы при 30.
 * `text-gray-300` с детектора v5 проходит при 30 мм (мягкий порог плотной опоры, журнал 0030).
 */
const EXPECTED_FALLBACK: readonly string[] = ['rulers-gray-200'];

const names = scanFixtureNames();
const results = new Map<string, SkewMeasure | null>();
const chunks = new Map<string, number[]>();

async function measured(name: string): Promise<SkewMeasure | null> {
  let result = results.get(name);
  if (result === undefined) {
    const ms: number[] = [];
    result = await measureSkewJpeg(scanFixture(name), PIXEL_LIMIT, {
      onChunk: (duration) => {
        ms.push(duration);
      },
    });
    results.set(name, result);
    chunks.set(name, ms);
  }
  return result;
}

const describeMeasure = (m: SkewMeasure | null): string => {
  if (m === null) {
    return 'null';
  }
  const profile =
    m.profile === null
      ? '—'
      : m.profile.us
          .map((u, i) => `${u.toFixed(2)}:${(m.profile?.thetas[i] ?? 0).toFixed(2)}`)
          .join(' ');
  const contrast = m.contrast === null ? '' : ` ×${m.contrast.ratio.toFixed(2)}`;
  const fan = m.fanMm === null ? '' : ` веер ${m.fanMm.toFixed(2)} мм`;
  const basis = m.basis === 'halves' ? ' по половинам' : '';
  return `${m.outcome.padEnd(15)} ${m.bandMm} мм${basis}${contrast}${fan} ${m.reason ?? ''} | ${profile}`;
};

describe('детектор перекоса на сканах ET-3850 (M6, U2)', () => {
  it('каталог сканов заведён и каждый скан есть в таблице ожиданий', () => {
    expect(names, 'сканов нет — U1: снять и положить в scans/').not.toEqual([]);
    for (const name of names) {
      expect(EXPECTED[name], `${name}: добавить в таблицу ожиданий`).toBeDefined();
    }
  });

  it('исход каждого скана — из ожидаемого класса; таблица печатается в журнал', async () => {
    const rows: string[] = [];
    for (const name of names) {
      rows.push(`${name.padEnd(24)} ${describeMeasure(await measured(name))}`);
    }
    console.log(`исходы детектора перекоса:\n${rows.join('\n')}`);
    for (const name of names) {
      const result = await measured(name);
      expect(result, name).not.toBeNull();
      expect(EXPECTED[name], `${name}: ${describeMeasure(result)}`).toContain(result?.outcome);
      if (result !== null && result.outcome !== 'unmeasurable') {
        expect(result.bandMm, name).toBe(
          EXPECTED_FALLBACK.includes(name) ? FALLBACK_BAND_MM : BAND_MM,
        );
      }
    }
  });

  it('половина с плоским пиком не накладывает вето: низ листа с линейками входит в профиль, блок строк рядом с плашкой держит оборот', async () => {
    // Приёмка M6 (2026-10-29): у половины полосы с одной плашкой или миллиметровыми рисками
    // пик резкости плоский, её угол — шум, и прежний гейт половин отбрасывал всю полосу. Низ
    // калибровочного листа (u 0,77 и 0,82, −0,95 / −0,90°) терялся, и лист поворачивался на
    // угол верха; оборот с плашкой оставался с двумя полосами из трёх нужных. Без правила
    // возражения (`HALF_OBJECTION_MIN`) тест падает.
    const rulers = await measured('rulers-gray-200');
    expect(rulers?.outcome).toBe('willStraighten');
    expect(Math.max(...(rulers?.profile?.us ?? [0]))).toBeGreaterThan(0.7);
    expect(rulers?.fanMm ?? 0).toBeGreaterThan(2);
    const back = await measured('sheet-back-gray-200');
    expect(back?.outcome).toBe('willStraighten');
    // Полоса пустой бумаги с просвечиванием (0,3 % чернил) — не полоса: порог `MIN_INK_FRACTION`.
    const validInk = (back?.bands ?? [])
      .filter((band) => band.reason === null)
      .map((band) => band.inkFraction);
    expect(validInk.length).toBeGreaterThanOrEqual(MIN_BANDS);
    expect(Math.min(...validInk)).toBeGreaterThanOrEqual(0.01);
  });

  it('две колонки: форма по целым полосам шумит, профиль — по среднему половин; штриховка так не проходит', async () => {
    // Замечание автора на приёмке M6: веер — свойство подачи, а не колонки; первая колонка
    // даёт чистую ступень, целая полоса — шум 0,1–0,2° от наложения фаз. Без запасного
    // профиля по половинам обе двухколоночные страницы — «не измерить» (остаток 0,13–0,23°).
    for (const name of ['fan-twocol-gray-300', 'fan-twocol-gray-200']) {
      const result = await measured(name);
      expect(result?.outcome, name).toBe('willStraighten');
      expect(result?.basis, name).toBe('halves');
      expect(result?.bandMm, name).toBe(BAND_MM);
    }
    for (const name of ['fan-text-gray-300', 'fan-grid-1-gray-300', 'fan-table-gray-300']) {
      expect((await measured(name))?.basis, name).toBe('whole');
    }
    expect((await measured('fan-graphic-gray-300'))?.outcome).toBe('unmeasurable');
  });

  it('графичная страница с плотной опорой: шум соседних полос 0,1–0,2° не валит форму, штриховка с дырой опоры — валит', async () => {
    // Скан автора 2026-10-31 (рабочая тетрадь: числовые прямые, рамки, крупные цифры): все полосы
    // валидны, половины согласны, углы +0,55° → −0,57°, но остаток ступени 0,17° при 30 мм —
    // при едином пороге 0,1° «наклон строк не сходится». Порог для узлов по плотной опоре —
    // `SHAPE_RESIDUAL_DENSE_MAX_DEG` 0,2°; прямая при дыре опоры держит строгий 0,1°.
    const worksheet = await measured('fan-worksheet-color-200');
    expect(worksheet?.outcome).toBe('willStraighten');
    expect(worksheet?.bandMm).toBe(BAND_MM);
    expect(worksheet?.basis).toBe('whole');
    expect(worksheet?.shapeResidual ?? 0).toBeGreaterThan(SHAPE_RESIDUAL_MAX_DEG);
    expect(worksheet?.shapeResidual ?? 1).toBeLessThanOrEqual(SHAPE_RESIDUAL_DENSE_MAX_DEG);
    expect(worksheet?.fanMm ?? 0).toBeGreaterThan(2);
    expect((await measured('fan-graphic-gray-300'))?.cause).toBe('shape');
  });

  it('причина «не измерена»: строки не сходятся у ловушек, не по чему мерить у фото и чистых; у измеренных — нет', async () => {
    for (const name of names) {
      const result = await measured(name);
      if (result === null) {
        continue;
      }
      const expected =
        result.outcome !== 'unmeasurable'
          ? null
          : name === 'fan-graphic-gray-300'
            ? 'shape'
            : 'content';
      expect(result.cause, `${name}: ${describeMeasure(result)}`).toBe(expected);
    }
  });

  it('выправляемые — с ростом контраста не меньше запаса; ровные — ниже порога движения', async () => {
    for (const name of names) {
      const result = await measured(name);
      if (result?.outcome === 'willStraighten') {
        expect(result.contrast?.ratio ?? 0, name).toBeGreaterThanOrEqual(IMPROVE_RATIO);
      }
      if (result?.outcome === 'level') {
        expect(Math.max(...(result.profile?.thetas.map(Math.abs) ?? [1])), name).toBeLessThan(
          LEVEL_DEG,
        );
      }
    }
  });

  it('запас по уверенности: у измеренных медиана валидных полос ≥ 2× порога', async () => {
    const lines: string[] = [];
    for (const name of names) {
      const result = await measured(name);
      if (result === null || result.outcome === 'unmeasurable') {
        continue;
      }
      const confidences = result.bands
        .filter((band) => band.reason === null)
        .map((band) => band.confidence)
        .sort((a, b) => a - b);
      const median = confidences[Math.floor(confidences.length / 2)] ?? 0;
      lines.push(
        `${name.padEnd(24)} медиана уверенности ${median.toFixed(1)} (${confidences.length} полос)`,
      );
      expect(median, name).toBeGreaterThanOrEqual(2 * CONFIDENCE_MIN);
    }
    console.log(lines.join('\n'));
  });

  it('бюджет чанков: на 300 dpi A4 чанк < 100 мс, измерение целиком < 2 с (цифры — в журнал)', async () => {
    const name = 'fan-text-gray-300';
    const started = performance.now();
    await measureSkewJpeg(scanFixture(name), PIXEL_LIMIT, {
      onChunk: (duration) => {
        (chunks.get(`${name}#fresh`) ?? chunks.set(`${name}#fresh`, []).get(`${name}#fresh`))?.push(
          duration,
        );
      },
    });
    const total = performance.now() - started;
    const ms = (chunks.get(`${name}#fresh`) ?? []).slice().sort((a, b) => a - b);
    const p95 = ms[Math.floor(ms.length * 0.95)] ?? 0;
    const max = ms[ms.length - 1] ?? 0;
    console.log(
      `чанки ${name}: ${ms.length} полос, p95 ${p95.toFixed(1)} мс, max ${max.toFixed(1)} мс, всего с декодом ${total.toFixed(0)} мс`,
    );
    expect(max).toBeLessThan(100);
    expect(total).toBeLessThan(2000);
  });

  it('сетки: веер по линиям на полном разрешении > 0,5 мм до коррекции; профиль детектора согласен с линиями', async () => {
    const lines: string[] = [];
    for (const name of names.filter((it) => it.startsWith('fan-grid-'))) {
      const grid = await analyzeGrid(scanFixture(name), dpiOfScanName(name));
      const result = await measured(name);
      const profile = result?.profile ?? null;
      expect(profile, name).not.toBeNull();
      let worst = 0;
      let sum = 0;
      for (const h of grid.horizontals) {
        const delta = Math.abs(
          skewThetaAt(profile ?? { kind: 'knots', us: [0], thetas: [0] }, h.u) - h.theta,
        );
        worst = Math.max(worst, delta);
        sum += delta;
      }
      const mean = sum / Math.max(1, grid.horizontals.length);
      lines.push(
        `${name.padEnd(24)} горизонталей ${grid.horizontals.length}, веер ${grid.fanMm.toFixed(2)} мм, наклон вертикалей ${grid.meanTilt.toFixed(3)}°; профиль против линий: max ${worst.toFixed(3)}°, mean ${mean.toFixed(3)}°`,
      );
      expect(grid.horizontals.length, name).toBeGreaterThanOrEqual(15);
      expect(grid.fanMm, name).toBeGreaterThan(0.5);
      expect(worst, name).toBeLessThanOrEqual(0.2);
      expect(mean, name).toBeLessThanOrEqual(0.08);
    }
    const tilt = await analyzeGrid(scanFixture('tilt-grid-gray-300'), 300);
    lines.push(
      `${'tilt-grid-gray-300'.padEnd(24)} горизонталей ${tilt.horizontals.length}, веер ${tilt.fanMm.toFixed(2)} мм, средний θ ${(tilt.horizontals.reduce((s, h) => s + h.theta, 0) / tilt.horizontals.length).toFixed(3)}°`,
    );
    console.log(lines.join('\n'));
    expect(tilt.fanMm).toBeLessThan(0.5);
  });

  it('синтетический JPEG 300 dpi (серый и цветной) со ступенью — willStraighten с узлами в допуске', async () => {
    const theta = stepTheta(0.2, -0.7, 0.55, 0.14);
    for (const channels of [1, 3] as const) {
      const bytes = await syntheticJpeg({ dpi: 300, channels, theta });
      const result = await measureSkewJpeg(bytes, PIXEL_LIMIT);
      expect(result?.outcome, `channels ${channels}`).toBe('willStraighten');
      const profile = result?.profile;
      expect(profile).not.toBeNull();
      profile?.us.forEach((u, i) => {
        if (Math.abs(u - 0.55) > 0.14) {
          expect(Math.abs((profile.thetas[i] ?? 0) - theta(u)), `u=${u}`).toBeLessThanOrEqual(0.05);
        }
      });
    }
  });

  it('синтетическая страница с текстом измерима; битый JPEG и не JPEG — null; предел пикселей — null', async () => {
    expect((await measureSkewJpeg(pageFixture(1), PIXEL_LIMIT))?.outcome).not.toBeUndefined();
    expect(
      await measureSkewJpeg(Uint8Array.of(0xff, 0xd8, 1, 2, 0xff, 0xd9), PIXEL_LIMIT),
    ).toBeNull();
    expect(await measureSkewJpeg(new TextEncoder().encode('<html>'), PIXEL_LIMIT)).toBeNull();
    expect(await measureSkewJpeg(pageFixture(1), 100 * 100)).toBeNull();
  });
});
