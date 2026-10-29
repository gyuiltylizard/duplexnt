import { useEffect, useState } from 'react';
import { prefersReducedMotion } from '../state/motion';

// Смена кадра на месте (план M6, U8; handoff M6 «Behaviour», «Смена вида на месте»): откат,
// «Выровнять», поздняя коррекция и пересчёт меняют адрес картинки той же страницы — компонент не
// перемонтируется, и прежний кадр должен остаться до готовности нового. Новый кадр грузится вне
// DOM (`decode()`), затем кладётся поверх прежнего слоем `--incoming` и проявляется; прежний
// снимается, когда переход кончился. Сбой загрузки — прежний остаётся, ошибка в лог. Без
// `decode()` (jsdom) и под `prefers-reduced-motion` — простая замена адреса: кадр в каждом
// случае такой же, как без движения (B-4, R3). Смена страницы — обычная замена: компонент
// перемонтируется по ключу страницы, хук стартует с нового адреса.

export interface ImageSwap {
  /** Адрес показанного кадра. */
  readonly shown: string;
  /** Новый кадр, уже декодированный, — проявляется поверх; `null` — подмены нет. */
  readonly incoming: string | null;
  /** Проявление началось (класс `is-in` ставится кадром позже монтирования слоя). */
  readonly incomingIn: boolean;
  /** Переход нового слоя кончился: он становится показанным, прежний снимается. */
  readonly settle: () => void;
}

interface Frames {
  readonly shown: string;
  readonly incoming: string | null;
}

/** Переход не пришёл (стили без длительности) — слой всё равно становится показанным. */
const SETTLE_FALLBACK_MS = 1000;

/** Кадр можно декодировать вне DOM; в jsdom — нет, там простая замена адреса. */
const CAN_DECODE =
  typeof HTMLImageElement !== 'undefined' &&
  typeof HTMLImageElement.prototype.decode === 'function';

export function useImageSwap(src: string): ImageSwap {
  const [frames, setFrames] = useState<Frames>({ shown: src, incoming: null });
  const [incomingIn, setIncomingIn] = useState(false);

  // Корректировка при рендере (react.dev «You Might Not Need an Effect»): адрес вернулся к
  // показанному, пока новый кадр грузился (быстрый Ctrl+Z), — подмены нет; без декодирования или
  // под `prefers-reduced-motion` — замена сразу.
  if (src === frames.shown) {
    if (frames.incoming !== null) {
      setFrames({ shown: src, incoming: null });
    }
  } else if (!CAN_DECODE || prefersReducedMotion()) {
    setFrames({ shown: src, incoming: null });
  }

  const loading = CAN_DECODE && src !== frames.shown && !prefersReducedMotion();
  useEffect(() => {
    if (!loading) {
      return;
    }
    let cancelled = false;
    const image = new Image();
    image.src = src;
    image.decode().then(
      () => {
        if (!cancelled) {
          setIncomingIn(false);
          setFrames((current) => ({ shown: current.shown, incoming: src }));
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          console.error('[renderer] новый кадр страницы не загрузился', src, error);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [src, loading]);

  const settle = (): void => {
    setIncomingIn(false);
    setFrames((current) =>
      current.incoming === null ? current : { shown: current.incoming, incoming: null },
    );
  };

  // Слой смонтирован — проявление следующим кадром; страховка на случай, если переход не придёт.
  const { incoming } = frames;
  useEffect(() => {
    if (incoming === null || typeof requestAnimationFrame !== 'function') {
      return;
    }
    const frame = requestAnimationFrame(() => {
      setIncomingIn(true);
    });
    const timer = setTimeout(settle, SETTLE_FALLBACK_MS);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [incoming]);

  return { shown: frames.shown, incoming, incomingIn, settle };
}
