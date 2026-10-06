// Ручные правки сессии (M3; ADR 0004, амендмент 2026-10-06): итоговое состояние, не лог
// операций. Журнал хранит его как есть, снимок отдаёт дословно, редактор шлёт целиком.

/** Ручной поворот страницы по часовой стрелке; 0 не хранится. */
export type EditAngle = 90 | 180 | 270;

export const EDIT_ANGLES: readonly EditAngle[] = [90, 180, 270];

/** Предел длины имени документа: дальше имя всё равно обрезается при сохранении. */
export const MAX_DOCUMENT_NAME_LENGTH = 200;

export interface SessionEdits {
  /** Явный порядок ленты ключами страниц; пустой — автосортировка включена. */
  readonly order: readonly string[];
  /** Ручные углы страниц по ключу; складываются с поворотом прохода оборотов. */
  readonly rotations: Readonly<Record<string, EditAngle>>;
  /** Удалённые страницы — пометка, не действие над файлами: исходник жив до закрытия сессии. */
  readonly deleted: readonly string[];
  /** Разрезы — позиции между соседями видимой ленты, по возрастанию. */
  readonly cuts: readonly number[];
  /** Имена документов, ровно `cuts.length + 1`; пустая строка — имя по умолчанию. */
  readonly names: readonly string[];
}

/** Правок нет: автосортировка, без поворотов и удалений, один документ с именем по умолчанию. */
export const EMPTY_EDITS: SessionEdits = {
  order: [],
  rotations: {},
  deleted: [],
  cuts: [],
  names: [''],
};
