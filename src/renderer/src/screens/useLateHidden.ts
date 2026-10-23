import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { sameList, type AssembledPage, type AssemblyMode } from '@shared';

// Поздние оценки (план M4, U6; KTD6; handoff M4, S13): снимок спрятал показанную страницу
// вердиктом детектора — один тост на снимок с числом только что скрытых. «Только что» — ключ,
// которого среди скрытых ещё не бывало за жизнь экрана: страница, вернувшаяся в скрытые после
// Ctrl+Z удаления, «Вернуть» или отмены пометки «не пустая», уже была скрыта — это не оценка, а
// правка, тоста нет (ревью сессий 3–4). Переход из наборов в «собрано» — не поздняя оценка: о
// скрытых после сборки говорит тост сборки (`useEditorAssemble`). При включённом переключателе
// ничего не исчезает — тоста нет. Корректировка состояния при рендере (StrictMode повторный
// рендер события не плодит), тост — эффектом по номеру события.

interface Seen {
  readonly hidden: readonly string[];
  /** Все ключи, бывавшие скрытыми за жизнь экрана: повторное скрытие — не поздняя оценка. */
  readonly everHidden: ReadonlySet<string>;
  readonly mode: AssemblyMode;
  /** Номер события «скрыто вердиктом»; растёт на каждый такой снимок. */
  readonly event: number;
  /** Сколько страниц скрыл последний такой снимок. */
  readonly count: number;
}

export function useLateHidden({
  order,
  mode,
  reveal,
  onHidden,
}: {
  /** Полная видимая лента снимка. */
  readonly order: readonly AssembledPage[];
  readonly mode: AssemblyMode;
  /** Скрытые показаны переключателем (R13). */
  readonly reveal: boolean;
  readonly onHidden: (count: number) => void;
}): void {
  const hiddenKeys = useMemo(
    () => order.filter((entry) => entry.blank === 'hidden').map((entry) => entry.key),
    [order],
  );
  const [seen, setSeen] = useState<Seen>(() => ({
    hidden: hiddenKeys,
    everHidden: new Set(hiddenKeys),
    mode,
    event: 0,
    count: 0,
  }));
  if (!sameList(seen.hidden, hiddenKeys) || seen.mode !== mode) {
    const fresh = hiddenKeys.filter((key) => !seen.everHidden.has(key));
    const assembled = seen.mode === 'sets' && mode === 'assembled';
    const late = fresh.length > 0 && !reveal && !assembled;
    setSeen({
      hidden: hiddenKeys,
      everHidden: new Set([...seen.everHidden, ...hiddenKeys]),
      mode,
      event: late ? seen.event + 1 : seen.event,
      count: late ? fresh.length : seen.count,
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
