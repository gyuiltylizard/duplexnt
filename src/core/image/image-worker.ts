import type { SkewMeasure, SkewPrior, SkewProfile } from '@shared';
import { measureSkewJpeg } from '../detect/skew';
import { straighten, type StraightenResult } from './straighten';

// Исполнитель картинок (план M6, U3; KTD-10; ADR 0008): граница между алгоритмом и тем, где
// он исполняется. Служба проходов (U5) и очередь коррекции (U11) получают интерфейс через
// опции — как `blankDetector`; в M6 единственная реализация — прямой исполнитель, который
// вызывает чистые `measureSkew` и `straighten` в вызывающем потоке чанками с точкой уступки.
// Поток `worker_threads` или процесс встанет на это место без правки вызывающих; триггеры
// пересмотра — ADR 0008.

export interface MeasureOptions {
  /** Подсказка устройства (M6.5); в M6 принимается и не читается. */
  readonly prior?: SkewPrior | null;
  /** Отмена между полосами (KTD-12). */
  readonly signal?: AbortSignal;
}

export interface StraightenJobOptions {
  readonly pixelLimit: number | null;
  readonly dpi: number | null;
  /** Отмена между полосами (KTD-12). */
  readonly signal?: AbortSignal;
}

export interface ImageWorker {
  /** Профиль наклона и исход измерения страницы JPEG; не JPEG или сбой декода — `null`. */
  measure(
    bytes: Uint8Array,
    pixelLimit: number | null,
    options?: MeasureOptions,
  ): Promise<SkewMeasure | null>;
  /** Выправленный JPEG по профилю; сбой декода — `null`. */
  straighten(
    bytes: Uint8Array,
    profile: SkewProfile,
    options: StraightenJobOptions,
  ): Promise<StraightenResult | null>;
}

export interface InlineImageWorkerOptions {
  /** Точка уступки между чанками; по умолчанию — макрозадача (`setImmediate`). */
  readonly yieldBetween?: () => Promise<void>;
  /** Длительность каждого чанка, мс — тестам и бенчу. */
  readonly onChunk?: (ms: number) => void;
}

/** Прямой исполнитель: обе операции в вызывающем потоке чанками (ADR 0008). */
export function inlineImageWorker(options: InlineImageWorkerOptions = {}): ImageWorker {
  return {
    measure: (bytes, pixelLimit, measure = {}) =>
      measureSkewJpeg(bytes, pixelLimit, { ...options, ...measure }),
    straighten: (bytes, profile, job) => straighten(bytes, profile, { ...options, ...job }),
  };
}
