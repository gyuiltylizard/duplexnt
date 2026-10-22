import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { sameList, type AssembledPage, type AssemblyMode } from '@shared';

// Поздние оценки (план M4, U6; KTD6; handoff M4, S13): снимок спрятал показанную страницу
// вердиктом детектора — не правкой (`notBlank` не менялся), не Ctrl+Z и не сборкой наборов, о
// которой уже сказал тост сборки, — один тост на снимок с числом только что скрытых. При
// включённом переключателе ничего не исчезает — тоста нет. Корректировка состояния при рендере
// (StrictMode повторный рендер события не плодит), тост — эффектом по номеру события.

interface Seen {
  readonly hidden: readonly string[];
  readonly notBlank: readonly string[];
  readonly mode: AssemblyMode;
  /** Номер события «скрыто вердиктом»; растёт на каждый такой снимок. */
  readonly event: number;
  /** Сколько страниц скрыл последний такой снимок. */
  readonly count: number;
}

export function useLateHidden({
  order,
  notBlank,
  mode,
  reveal,
  announced,
  onHidden,
}: {
  /** Полная видимая лента снимка. */
  readonly order: readonly AssembledPage[];
  /** Пометки «не пустая» снимка: их смена — правка, не вердикт. */
  readonly notBlank: readonly string[];
  readonly mode: AssemblyMode;
  /** Скрытые показаны переключателем (R13). */
  readonly reveal: boolean;
  /** О скрытых после сборки наборов уже сказал тост сборки — повторять не нужно. */
  readonly announced: boolean;
  readonly onHidden: (count: number) => void;
}): void {
  const hiddenKeys = useMemo(
    () => order.filter((entry) => entry.blank === 'hidden').map((entry) => entry.key),
    [order],
  );
  const [seen, setSeen] = useState<Seen>(() => ({
    hidden: hiddenKeys,
    notBlank,
    mode,
    event: 0,
    count: 0,
  }));
  if (
    !sameList(seen.hidden, hiddenKeys) ||
    !sameList(seen.notBlank, notBlank) ||
    seen.mode !== mode
  ) {
    const known = new Set(seen.hidden);
    const fresh = hiddenKeys.filter((key) => !known.has(key)).length;
    const assembled = seen.mode === 'sets' && mode === 'assembled' && announced;
    const late = fresh > 0 && !reveal && !assembled && sameList(seen.notBlank, notBlank);
    setSeen({
      hidden: hiddenKeys,
      notBlank,
      mode,
      event: late ? seen.event + 1 : seen.event,
      count: late ? fresh : seen.count,
    });
  }
  const announce = useEffectEvent((count: number) => {
    onHidden(count);
  });
  useEffect(() => {
    if (seen.event > 0) {
      announce(seen.count);
    }
  }, [seen.event, seen.count]);
}
