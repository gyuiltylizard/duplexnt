import { useState } from 'react';

// Автомат загрузки `<img>` для миниатюр и превью (S19): скелетон, пока грузится; своя
// плашка, когда не загрузилась. Один на StripCard, Thumb и Preview.
//
// Смена страницы — перемонтирование: стабильный `key` по ключу страницы у всех трёх
// потребителей, состояние стартует заново. Адрес той же страницы меняется на месте (вид по
// статусу выравнивания, M6): после сбоя новый адрес — новая попытка, иначе плашка без `<img>`
// осталась бы навсегда; загруженное состояние не сбрасывается — смена кадра идёт без скелетона.

export interface ImageLoad {
  readonly state: 'loading' | 'ok' | 'failed';
  readonly onLoad: () => void;
  readonly onError: () => void;
}

export function useImageLoad(src: string): ImageLoad {
  const [load, setLoad] = useState<{ readonly src: string; readonly state: ImageLoad['state'] }>({
    src,
    state: 'loading',
  });
  if (load.src !== src) {
    setLoad({ src, state: load.state === 'failed' ? 'loading' : load.state });
  }
  return {
    state: load.state,
    onLoad: () => {
      setLoad((current) => ({ ...current, state: 'ok' }));
    },
    onError: () => {
      setLoad((current) => ({ ...current, state: 'failed' }));
    },
  };
}
