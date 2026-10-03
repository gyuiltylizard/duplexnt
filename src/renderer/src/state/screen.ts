import type { Snapshot } from '@shared';

// Экран выводится из снимка чистой функцией (план M1, U20): своего состояния навигации у
// интерфейса нет. Пять экранов UI_SPEC в M1 сужены до четырёх: `flip` и `merge` не рендерятся
// (временное ребро scan → editor, UI_SPEC раздел 1).

export type Screen = 'incompatible' | 'scan' | 'editor' | 'setup';

export function screenOf(snapshot: Snapshot): Screen {
  // Режим отказа хранилища перекрывает всё: ни прохода, ни сессии на этом экране нет (KTD-35).
  if (snapshot.storage.incompatible) {
    return 'incompatible';
  }
  if (snapshot.pass !== null) {
    return 'scan';
  }
  if (snapshot.session !== null) {
    return 'editor';
  }
  return 'setup';
}
