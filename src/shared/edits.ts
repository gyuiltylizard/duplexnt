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
  /**
   * Граница наборов в режиме раздельных наборов (M3.6; ADR 0004, амендмент 2026-10-19): позиция
   * в видимой ленте, перед которой начинается набор оборотов; 0 и «все страницы» допустимы.
   * `null` — авто: число видимых страниц набора лиц по базовому порядку; вне режима — всегда
   * `null`. Перенос через разделитель задаёт её явно, «Вернуть» сбрасывает, сборка обнуляет.
   */
  readonly divider: number | null;
  /**
   * Страницы, принятые пользователем непустыми (M4; ADR 0004, амендмент 2026-10-22): снимают
   * любой флаг детектора. Обычная правка — шаг undo, плашка, «Вернуть» снимает. Обратной пометки
   * «считать пустой» нет: лишнее удаляется.
   */
  readonly notBlank: readonly string[];
}

/** Правок нет: автосортировка, без поворотов и удалений, один документ с именем по умолчанию. */
export const EMPTY_EDITS: SessionEdits = {
  order: [],
  rotations: {},
  deleted: [],
  cuts: [],
  names: [''],
  divider: null,
  notBlank: [],
};

/** Списки равны поэлементно. */
export const sameList = <T>(left: readonly T[], right: readonly T[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/**
 * Равны ли правки по содержанию. Углы сравниваются по ключам, а не по порядку записи: журнал с
 * диска и нормализованный вход могут перечислять их в разном порядке. Общая для ядра (запись
 * без изменений не идёт в журнал) и редактора (жест без изменений — не шаг undo).
 */
export function sameEdits(left: SessionEdits, right: SessionEdits): boolean {
  const leftAngles = Object.entries(left.rotations);
  return (
    sameList(left.order, right.order) &&
    sameList(left.deleted, right.deleted) &&
    sameList(left.cuts, right.cuts) &&
    sameList(left.names, right.names) &&
    left.divider === right.divider &&
    sameList(left.notBlank, right.notBlank) &&
    leftAngles.length === Object.keys(right.rotations).length &&
    leftAngles.every(([key, angle]) => right.rotations[key] === angle)
  );
}
