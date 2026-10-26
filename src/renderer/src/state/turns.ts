// Реестр поворотов по команде (B-4, план KTD-3; handoff «3. Поворот»). Анимация знает команду,
// а не углы: угол страницы приходит в ленту из сборки снимка позже нажатия и хранится по
// модулю 360 — по нему 270° → 0° крутилось бы назад. Команда (↺ ↻, тумблер 180°) отмечает
// здесь дельту для своих страниц; миниатюра и превью, увидев смену угла, берут дельту из свежей
// отметки. Смена угла без отметки — undo, redo, перезапуск — не анимируется.

export interface Turn {
  /** ↻ +90, ↺ −90, тумблер 180° включили +180, выключили −180. */
  readonly delta: number;
  /** Номер команды: каждый потребитель отрабатывает команду один раз. */
  readonly seq: number;
  readonly at: number;
}

/** Дольше отметка не ждёт снимка: отклонённая команда не должна оживить чужую смену угла. */
export const TURN_TTL_MS = 3000;

const turns = new Map<string, Turn>();
let lastSeq = 0;

export function markTurn(keys: readonly string[], delta: number): void {
  lastSeq += 1;
  const turn: Turn = { delta, seq: lastSeq, at: performance.now() };
  for (const key of keys) {
    turns.set(key, turn);
  }
}

/** Свежая отметка страницы, ещё не отработанная этим потребителем (`handled` — его последний seq). */
export function freshTurn(key: string, handled: number): Turn | null {
  const turn = turns.get(key);
  if (turn === undefined || turn.seq === handled || performance.now() - turn.at > TURN_TTL_MS) {
    return null;
  }
  return turn;
}

/** ТОЛЬКО ДЛЯ ТЕСТОВ. */
export function clearTurns(): void {
  turns.clear();
}
