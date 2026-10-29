import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { durationOf } from '../state/motion';

// Пометки выравнивания (handoff M6 «Anatomy», «Behaviour»): глиф 10×9 штрихом `currentColor` —
// три ровные строки («выровнено») или три косые с волной («не выровнено»); точки обработки —
// три точки `pulse` в общей фазе: при монтировании ставится `--straight-phase =
// −(now mod --duration-loop)`, и десятки карточек «дышат» целиком, включая пришедшие позже.
// Появление — проявлением: класс `--entering` снимается следующим кадром (CSS даёт переход).

const LEVEL = 'M0.6 1H9.4M0.6 4.5H9.4M0.6 8H9.4';
const UNDONE =
  'M0.6 2.8Q2.8 1 5 1.9T9.4 0.7M0.6 6Q2.8 4.2 5 5.1T9.4 3.9M0.6 9.2Q2.8 7.4 5 8.3T9.4 7.1';

/** Токен не прочитан (стили не подключены) — цикл `pulse` из дизайн-системы. */
const LOOP_FALLBACK_MS = 1200;

export function StraightGlyph({ kind }: { readonly kind: 'level' | 'undone' }): ReactNode {
  return (
    <svg className="straight-glyph" viewBox="0 0 10 9" aria-hidden="true">
      <path d={kind === 'level' ? LEVEL : UNDONE} />
    </svg>
  );
}

/** Общая фаза точек: отрицательная задержка, чтобы новая карточка попала в такт остальных. */
function phaseStyle(): CSSProperties {
  const loop = durationOf('--duration-loop') || LOOP_FALLBACK_MS;
  const phase = -(performance.now() % loop);
  return { '--straight-phase': `${String(Math.round(phase))}ms` } as CSSProperties;
}

/** Три точки обработки; фаза считается один раз при монтировании. */
export function StraightDots({
  className,
  title,
}: {
  readonly className: string;
  readonly title?: string | undefined;
}): ReactNode {
  const [style] = useState(phaseStyle);
  return (
    <span className={className} aria-hidden="true" title={title} style={style}>
      <i />
      <i />
      <i />
    </span>
  );
}

/** `true` в первом кадре после монтирования — класс проявления, снимаемый следующим кадром. */
export function useEntering(): boolean {
  // Без кадров (нет rAF) проявлять нечем — сразу конечное состояние.
  const [entering, setEntering] = useState(typeof requestAnimationFrame === 'function');
  useEffect(() => {
    if (!entering) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      setEntering(false);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [entering]);
  return entering;
}
