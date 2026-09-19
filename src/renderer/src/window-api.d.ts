import type { Api } from '@shared';

// Объявление лежит в дереве renderer, а не рядом с контрактом: у пары `index.ts` / `index.d.ts`
// glob забирает только `.ts`. Импорт выше обязателен — без него файл перестаёт быть модулем,
// и `declare global` молча не срабатывает.
declare global {
  interface Window {
    readonly api: Api;
  }
}
