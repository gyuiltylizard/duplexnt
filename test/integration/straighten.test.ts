import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { skewFanMm, skewMaxAbsDeg, skewProfileOf, type SkewMeasure } from '@shared';
import { measureSkewJpeg } from '../../src/core/detect/skew';
import {
  rawPaperWhite,
  STRAIGHT_SIZE_RATIO,
  STRAIGHTEN_ENCODING,
  straighten,
} from '../../src/core/image/straighten';
import { jfifDpi } from '../../src/core/pdf/assemble';
import { pageFixture, scanFixture, scanFixtureNames } from '../support/fixtures';
import { analyzeGrid, dpiOfScanName } from '../support/grid-analysis';
import { stepTheta, syntheticJpeg } from '../support/synthetic-page';

// Ресэмплер на настоящих сканах ET-3850 (план M6, U3; R7–R9, R24; амендмент 2026-10-28):
// каждая выправляемая фикстура проходит круг «измерение → коррекция → декод → повторное
// измерение», сетки — анализ линий на полном разрешении (критерий ≤ 0,5 мм), ловушки — не
// хуже оригинала; формат выхода (каналы, размер, плотность, сегменты JFIF), размер файла
// (`STRAIGHT_SIZE_RATIO`), бюджет чанков. Цифры печатаются — в журнал и техбазу.

/** Предел пикселей ET-3850 при 600 dpi на A4 с запасом — как в журнале прохода. */
const PIXEL_LIMIT = 5100 * 8400;

/**
 * Остаток после коррекции по повторному измерению: наибольший |θ| и веер. Страница, прошедшая
 * только запасным проходом 50 мм, несёт колено ступени грубее — допуск по вееру вдвое шире.
 */
const RESIDUAL_MAX_DEG = 0.15;
const RESIDUAL_FAN_MM: Readonly<Record<number, number>> = { 30: 0.5, 50: 1 };

const names = scanFixtureNames();
const measures = new Map<string, SkewMeasure | null>();

async function measured(name: string): Promise<SkewMeasure | null> {
  let result = measures.get(name);
  if (result === undefined) {
    result = await measureSkewJpeg(scanFixture(name), PIXEL_LIMIT);
    measures.set(name, result);
  }
  return result;
}

interface Straightened {
  readonly name: string;
  readonly input: Buffer;
  readonly measure: SkewMeasure;
  readonly jpeg: Uint8Array;
  readonly again: SkewMeasure | null;
}

const outputs = new Map<string, Straightened | null>();

/** Выправленный скан по профилю детектора; не `willStraighten` — `null`. */
async function straightened(name: string): Promise<Straightened | null> {
  let result = outputs.get(name);
  if (result === undefined) {
    const measure = await measured(name);
    if (measure?.outcome !== 'willStraighten' || measure.profile === null) {
      result = null;
    } else {
      const input = scanFixture(name);
      const out = await straighten(input, measure.profile, {
        pixelLimit: PIXEL_LIMIT,
        dpi: dpiOfScanName(name),
      });
      expect(out, name).not.toBeNull();
      const jpeg = out?.jpeg ?? new Uint8Array();
      result = { name, input, measure, jpeg, again: await measureSkewJpeg(jpeg, PIXEL_LIMIT) };
    }
    outputs.set(name, result);
  }
  return result;
}

/** Маркеры сегментов JPEG до начала скана (SOS): порядок заголовков выхода. */
function jpegSegments(bytes: Uint8Array): number[] {
  const markers: number[] = [];
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xda) {
      break;
    }
    markers.push(marker);
    at += 2 + (((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0));
  }
  return markers;
}

const hasIcc = (bytes: Uint8Array): boolean =>
  Buffer.from(bytes.subarray(0, Math.min(bytes.length, 1 << 16))).includes('ICC_PROFILE');

const describeAgain = (m: SkewMeasure | null): string =>
  m === null
    ? 'null'
    : `${m.outcome}${m.profile === null ? '' : ` max|θ| ${skewMaxAbsDeg(m.profile).toFixed(3)}° веер ${skewFanMm(m.profile).toFixed(2)} мм`}`;

describe('ресэмплер на сканах ET-3850 (M6, U3)', () => {
  it(
    'выправляемые сканы: формат выхода, размер файла, остаток по повторному измерению (таблица — в журнал)',
    { timeout: 120_000 },
    async () => {
      const rows: string[] = [];
      const checks: (() => void)[] = [];
      let worstRatio = 0;
      for (const name of names) {
        const result = await straightened(name);
        if (result === null) {
          continue;
        }
        const { input, jpeg, measure, again } = result;
        const [before, after] = await Promise.all([
          sharp(input).metadata(),
          sharp(jpeg).metadata(),
        ]);
        expect(after.width, name).toBe(before.width);
        expect(after.height, name).toBe(before.height);
        expect(after.channels, name).toBe(before.channels);
        expect(jfifDpi(jpeg), name).toBe(dpiOfScanName(name));
        const ratio = jpeg.byteLength / input.byteLength;
        worstRatio = Math.max(worstRatio, ratio);
        rows.push(
          `${name.padEnd(22)} ${String(before.channels)} кан. ${(input.byteLength / 1024).toFixed(0).padStart(5)} → ${(jpeg.byteLength / 1024).toFixed(0).padStart(5)} КБ (×${ratio.toFixed(2)}); до (${measure.bandMm} мм): веер ${measure.fanMm?.toFixed(2)} мм ×${measure.contrast?.ratio.toFixed(2)}; после: ${describeAgain(again)}`,
        );
        checks.push(() => {
          // Лист, который после коррекции нечем измерить, — не «остаток в допуске», а провал
          // стража: коррекция, после которой профиль не читается, прошла бы молча (ревью сессий 1–2).
          const profile = again?.profile ?? null;
          expect(profile, `${name}: после коррекции ${describeAgain(again)}`).not.toBeNull();
          if (profile === null) {
            return;
          }
          expect(skewMaxAbsDeg(profile), name).toBeLessThanOrEqual(RESIDUAL_MAX_DEG);
          expect(skewFanMm(profile), name).toBeLessThanOrEqual(
            RESIDUAL_FAN_MM[measure.bandMm] ?? 0,
          );
        });
      }
      console.log(
        `коррекция сканов:\n${rows.join('\n')}\nнаибольший размер выход/вход ×${worstRatio.toFixed(2)}`,
      );
      for (const check of checks) {
        check();
      }
      expect(rows.length).toBeGreaterThanOrEqual(8);
      expect(worstRatio).toBeLessThanOrEqual(STRAIGHT_SIZE_RATIO);
    },
  );

  it(
    'сетки: после коррекции расхождение концов ≤ 0,5 мм и наклон вертикалей ≤ 0,1° на полном разрешении',
    { timeout: 120_000 },
    async () => {
      const lines: string[] = [];
      for (const name of names.filter((it) => it.startsWith('fan-grid-'))) {
        const result = await straightened(name);
        expect(result, name).not.toBeNull();
        if (result === null) {
          continue;
        }
        const dpi = dpiOfScanName(name);
        const [before, after] = await Promise.all([
          analyzeGrid(result.input, dpi),
          analyzeGrid(result.jpeg, dpi),
        ]);
        const bow = Math.max(...after.verticals.map((v) => v.bowMm));
        lines.push(
          `${name.padEnd(22)} веер ${before.fanMm.toFixed(2)} → ${after.fanMm.toFixed(2)} мм; вертикали ${before.meanTilt.toFixed(3)}° → ${after.meanTilt.toFixed(3)}°, изгиб ≤ ${bow.toFixed(2)} мм (${after.horizontals.length} гор., ${after.verticals.length} верт.)`,
        );
        expect(after.horizontals.length, name).toBeGreaterThanOrEqual(15);
        expect(after.verticals.length, name).toBeGreaterThanOrEqual(10);
        expect(after.fanMm, name).toBeLessThanOrEqual(0.5);
        expect(Math.abs(after.meanTilt), name).toBeLessThanOrEqual(0.1);
      }
      console.log(lines.join('\n'));
      expect(lines.length).toBe(3);
    },
  );

  it(
    'ловушки (две колонки, косая штриховка): выправляются не хуже или не трогаются (R24)',
    { timeout: 120_000 },
    async () => {
      for (const name of ['fan-twocol-gray-300', 'fan-graphic-gray-300']) {
        const result = await straightened(name);
        if (result === null) {
          console.log(`${name}: ${(await measured(name))?.outcome} — не трогается`);
          continue;
        }
        const fanBefore = result.measure.fanMm ?? 0;
        // Неизмеримый после коррекции лист — провал R24, а не «веер 0»: страж как раз об этом.
        const profile = result.again?.profile ?? null;
        expect(profile, `${name}: после коррекции ${describeAgain(result.again)}`).not.toBeNull();
        const fanAfter = profile === null ? Number.POSITIVE_INFINITY : skewFanMm(profile);
        console.log(`${name}: веер ${fanBefore.toFixed(2)} → ${fanAfter.toFixed(2)} мм`);
        expect(fanAfter, name).toBeLessThanOrEqual(fanBefore);
      }
    },
  );

  it(
    'синтетический JPEG 300 dpi: серый → 1 канал, цветной → 3; плотность в APP0 сразу после SOI; ICC фиксируется; углы — белым бумаги',
    { timeout: 120_000 },
    async () => {
      const theta = stepTheta(0.2, -0.7, 0.55, 0.14);
      const tilt = skewProfileOf([{ u: 0.5, theta: 1 }]);
      const notes: string[] = [];
      for (const channels of [1, 3] as const) {
        const bytes = await syntheticJpeg({ dpi: 300, channels, theta, lateral: true });
        const measure = await measureSkewJpeg(bytes, PIXEL_LIMIT);
        expect(measure?.outcome, `channels ${channels}`).toBe('willStraighten');
        const profile = measure?.profile ?? tilt;
        const out = await straighten(bytes, profile, { pixelLimit: PIXEL_LIMIT, dpi: 300 });
        expect(out, `channels ${channels}`).not.toBeNull();
        if (out === null) {
          continue;
        }
        expect(out.encoding).toBe(STRAIGHTEN_ENCODING);
        expect(out.dpi).toBe(300);
        expect(out.info.channels).toBe(channels);
        const meta = await sharp(out.jpeg).metadata();
        expect(meta.channels).toBe(channels);
        expect(meta.width).toBe(out.info.width);
        expect(jfifDpi(out.jpeg)).toBe(300);
        const segments = jpegSegments(out.jpeg);
        expect(segments[0]).toBe(0xe0);
        notes.push(
          `${channels} кан.: сегменты ${segments.map((m) => m.toString(16)).join(' ')}, ICC ${hasIcc(out.jpeg) ? 'есть' : 'нет'}, ${(bytes.byteLength / 1024).toFixed(0)} → ${(out.jpeg.byteLength / 1024).toFixed(0)} КБ`,
        );
        const again = await measureSkewJpeg(out.jpeg, PIXEL_LIMIT);
        expect(again?.outcome, `channels ${channels}`).toBe('level');

        // Плотность не задана — из JFIF входа (синтетика пишет 300).
        const inherited = await straighten(bytes, profile, { pixelLimit: PIXEL_LIMIT, dpi: null });
        expect(inherited?.dpi).toBe(300);
        expect(jfifDpi(inherited?.jpeg ?? new Uint8Array())).toBe(300);

        // Углы после общего наклона 1° — цвета бумаги, не чёрные и не 255.
        const tilted = await straighten(bytes, tilt, { pixelLimit: PIXEL_LIMIT, dpi: 300 });
        const { data, info } = await sharp(tilted?.jpeg ?? new Uint8Array())
          .raw()
          .toBuffer({ resolveWithObject: true });
        const raw = {
          data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
          width: info.width,
          height: info.height,
          channels: info.channels,
        };
        const white = rawPaperWhite(raw);
        expect(white[0]).toBeGreaterThan(150);
        expect(white[0]).toBeLessThan(255);
        for (const corner of [0, (info.height - 1) * info.width + info.width - 1]) {
          for (let c = 0; c < channels; c += 1) {
            expect(Math.abs((raw.data[corner * channels + c] ?? 0) - (white[c] ?? 0))).toBeLessThan(
              6,
            );
          }
        }
      }
      console.log(notes.join('\n'));
    },
  );

  it(
    'бюджет чанков: на 300 dpi A4 чанк p95 ≤ 30 мс, max < 100 мс; время — в журнал',
    { timeout: 120_000 },
    async () => {
      const name = 'fan-text-gray-300';
      const measure = await measured(name);
      expect(measure?.profile).not.toBeNull();
      const chunks: number[] = [];
      const started = performance.now();
      await straighten(
        scanFixture(name),
        measure?.profile ?? skewProfileOf([{ u: 0.5, theta: 0 }]),
        {
          pixelLimit: PIXEL_LIMIT,
          dpi: 300,
          onChunk: (ms) => {
            chunks.push(ms);
          },
        },
      );
      const total = performance.now() - started;
      const sorted = chunks.slice().sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
      const max = sorted[sorted.length - 1] ?? 0;
      console.log(
        `чанки коррекции ${name}: ${chunks.length} полос, p95 ${p95.toFixed(1)} мс, max ${max.toFixed(1)} мс, всего с декодом и кодированием ${total.toFixed(0)} мс`,
      );
      expect(p95).toBeLessThanOrEqual(30);
      expect(max).toBeLessThan(100);
    },
  );

  it('уже отменённый сигнал: отказ причиной сигнала до декода — и для страницы, которую не декодировать', async () => {
    const profile = skewProfileOf([{ u: 0.5, theta: 0.5 }]);
    const controller = new AbortController();
    controller.abort(new Error('стоп'));
    const chunks: number[] = [];
    const options = {
      pixelLimit: PIXEL_LIMIT,
      dpi: 300,
      signal: controller.signal,
      onChunk: (ms: number) => {
        chunks.push(ms);
      },
    };

    await expect(straighten(pageFixture(1), profile, options)).rejects.toThrow('стоп');
    // Без проверки до декода битая страница дала бы `null`, а не отказ отменой.
    await expect(
      straighten(Uint8Array.of(0xff, 0xd8, 1, 2, 0xff, 0xd9), profile, options),
    ).rejects.toThrow('стоп');
    expect(chunks).toEqual([]);
  });

  it('отмена на последней полосе: отказ причиной сигнала, выход не кодируется', async () => {
    const profile = skewProfileOf([{ u: 0.5, theta: 0.5 }]);
    const bytes = pageFixture(1);
    const meta = await sharp(bytes).metadata();
    const controller = new AbortController();
    let chunks = 0;
    const run = straighten(bytes, profile, {
      pixelLimit: PIXEL_LIMIT,
      dpi: 300,
      // Одна полоса на всю страницу: её чанк — последний, цикл полос отмену уже не проверит.
      bandPixels: meta.width * meta.height,
      signal: controller.signal,
      onChunk: () => {
        chunks += 1;
        controller.abort(new Error('стоп'));
      },
    });

    await expect(run).rejects.toThrow('стоп');
    expect(chunks).toBe(1);
  });

  it('ошибка колбэка вызывающего без отмены пробрасывается, а не превращается в null', async () => {
    const profile = skewProfileOf([{ u: 0.5, theta: 0.5 }]);
    const run = straighten(pageFixture(1), profile, {
      pixelLimit: PIXEL_LIMIT,
      dpi: 300,
      onChunk: () => {
        throw new Error('bench');
      },
    });

    await expect(run).rejects.toThrow('bench');
    // Оставшийся путь к `null` — сбой libvips при кодировании — не проверяется: без мока
    // заставить libvips упасть на кодировании нельзя, а `sharp` в проекте не мокается.
  });

  it('битый JPEG, не JPEG и превышение предела пикселей — null', async () => {
    const profile = skewProfileOf([{ u: 0.5, theta: 0.5 }]);
    const options = { pixelLimit: PIXEL_LIMIT, dpi: 300 };
    expect(
      await straighten(Uint8Array.of(0xff, 0xd8, 1, 2, 0xff, 0xd9), profile, options),
    ).toBeNull();
    expect(await straighten(new TextEncoder().encode('<html>'), profile, options)).toBeNull();
    expect(
      await straighten(pageFixture(1), profile, { ...options, pixelLimit: 100 * 100 }),
    ).toBeNull();
    expect(await straighten(pageFixture(1), profile, options)).not.toBeNull();
  });
});
