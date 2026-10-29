import { STRAIGHTEN_GEOMETRY_VERSION, type SkewMeasure } from '../../src/shared';
import { inlineImageWorker, type ImageWorker } from '../../src/core/image/image-worker';
import type { SkewMeasurer } from '../../src/core/storage/skew-scores';

// Подставной исполнитель картинок для тестов службы и оценок перекоса (M6, U5): считает вызовы
// измерения, при `gated` держит ответы до `release` и честно слушает отмену — как настоящий
// детектор между полосами; измерение по умолчанию настоящее, коррекция — всегда настоящая.

export type MeasureStub = (
  bytes: Uint8Array,
  pixelLimit: number | null,
) => Promise<SkewMeasure | null>;

export interface StubWorkerOptions {
  /** Чем отвечать после отпускания; по умолчанию — настоящий детектор. */
  readonly measure?: MeasureStub;
  /** Держать ответы до `release`; иначе отвечать сразу. */
  readonly gated?: boolean;
}

/** Ждёт затвора, но отменяется сигналом — ожидание не переживает `abort`. */
function waitOrAbort(gate: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      reject(new Error('измерение отменено'));
    };
    if (signal?.aborted === true) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    void gate.then(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    });
  });
}

export function stubWorker(options: StubWorkerOptions = {}) {
  const real = inlineImageWorker();
  const measure: MeasureStub = options.measure ?? ((bytes, limit) => real.measure(bytes, limit));
  const calls: Uint8Array[] = [];
  let release = (): void => undefined;
  const gate =
    options.gated === true
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : Promise.resolve();
  const worker: ImageWorker = {
    measure: async (bytes, limit, measureOptions) => {
      calls.push(bytes);
      await waitOrAbort(gate, measureOptions?.signal);
      return measure(bytes, limit);
    },
    straighten: (bytes, profile, job) => real.straighten(bytes, profile, job),
  };
  const measurer: SkewMeasurer = (bytes, limit, measureOptions) =>
    worker.measure(bytes, limit, measureOptions);
  return {
    worker,
    /** Измерение как зависимость оценок — без привязки метода. */
    measurer,
    /** Байты каждой измеренной страницы в порядке вызовов. */
    calls,
    started: (): number => calls.length,
    release: (): void => {
      release();
    },
  };
}

/** Измерение настоящим детектором как зависимость оценок. */
export const realMeasurer: SkewMeasurer = (bytes, limit, options) =>
  inlineImageWorker().measure(bytes, limit, options);

/** Измерение «ровно» без детектора: страница остаётся оригиналом, очередь коррекции пуста. */
export const LEVEL_MEASURE: SkewMeasure = {
  outcome: 'level',
  cause: null,
  basis: 'whole',
  geometryVersion: STRAIGHTEN_GEOMETRY_VERSION,
  profile: { kind: 'knots', us: [0.5], thetas: [0] },
  contrast: null,
  fanMm: 0,
  bands: [],
  bandMm: 30,
  coverage: 1,
  shapeResidual: null,
  reason: null,
};

/**
 * Исполнитель для тестов, которым выравнивание не нужно: настоящее измерение стоит ~200 мс
 * страницы в потоке теста и валит эмуляторные сценарии на 24–30 страниц в таймаут. Отвечает
 * «ровно» сразу; тесты выравнивания передают свой.
 */
export const levelWorker: ImageWorker = stubWorker({
  measure: () => Promise.resolve(LEVEL_MEASURE),
}).worker;
