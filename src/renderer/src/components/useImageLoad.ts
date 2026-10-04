import { useState } from 'react';

// Автомат загрузки `<img>` для миниатюр и превью (S19): скелетон, пока грузится; своя
// плашка, когда не загрузилась. Один на StripCard, Thumb и Preview.
//
// Состояние не сбрасывается при смене `src`: компонент с хуком обязан перемонтироваться на
// каждую картинку (стабильный `key` по ключу страницы — так делают все три потребителя).

export interface ImageLoad {
  readonly state: 'loading' | 'ok' | 'failed';
  readonly onLoad: () => void;
  readonly onError: () => void;
}

export function useImageLoad(): ImageLoad {
  const [state, setState] = useState<ImageLoad['state']>('loading');
  return {
    state,
    onLoad: () => {
      setState('ok');
    },
    onError: () => {
      setState('failed');
    },
  };
}
