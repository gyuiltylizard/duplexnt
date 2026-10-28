import type { SessionEdits, SetsLayout } from '@shared';
import { dividerAfterMove, moved, movedAcross, type DropSide, type SetSide } from '../state/edits';
import type { EditState } from '../state/history';
import { selectionOf } from '../state/selection';
import { movingOf, sheetDrop, type GluedBacks } from '../state/shown';
import type { EditorEdits } from './useEditorEdits';

// Перенос страниц ленты (S6 M3; M3.6, KTD8; B-13) — жесты экрана `editor`, вынесенные из
// `EditorScreen` (ориентир R21): бросок на миниатюру и бросок через разделитель наборов. Правки
// строит `state/edits.ts`, склейку — `state/shown.ts`; здесь только сборка аргументов и
// выделение после переноса.

export interface RailMovesInput {
  readonly edits: EditorEdits;
  /** Полная видимая лента и позиции в ней. */
  readonly visible: readonly string[];
  readonly positions: ReadonlyMap<string, number>;
  /** Склеенные обороты «оборот → лицо» (B-13). */
  readonly glued: GluedBacks;
  /** Группы режима раздельных наборов; `null` — документы. */
  readonly sets: SetsLayout | null;
  /** Правки с текущим тумблером 180°. */
  readonly withEdits: (next: SessionEdits) => EditState;
  readonly focusInRail: () => boolean;
  /** Перенос ушёл из ленты: фокус вернётся на текущую миниатюру после снимка с результатом. */
  readonly onMovedFromRail: () => void;
}

export interface RailMoves {
  readonly move: (keys: readonly string[], target: string, side: DropSide) => void;
  readonly moveAcross: (keys: readonly string[], side: SetSide) => void;
}

export function railMovesOf({
  edits,
  visible,
  positions,
  glued,
  sets,
  withEdits,
  focusInRail,
  onMovedFromRail,
}: RailMovesInput): RailMoves {
  /**
   * Перенос ушёл: выделены перенесённые страницы пользователя на новом месте (склеенные обороты
   * в выделение не входят, KTD-3), текущая — прежняя; Ctrl+Z выделит всё перенесённое.
   */
  const sendMove = (
    next: SessionEdits,
    moving: readonly string[],
    selected: readonly string[] = moving,
  ): void => {
    const { current } = edits.selection;
    const fromRail = focusInRail();
    const sent = edits.edit(withEdits(next), moving, {
      select: (after) => {
        const chosen = selectionOf(selected, after);
        return chosen !== null && current !== null && chosen.keys.includes(current)
          ? { ...chosen, current, anchor: current }
          : chosen;
      },
    });
    // Миниатюра, сменившая группу, перемонтируется — фокус вернётся на текущую после снимка.
    if (sent && fromRail) {
      onMovedFromRail();
    }
  };

  // Перенос (S6): группа — с внутренним порядком ленты; бросок на исходное место — шага нет.
  // В режиме наборов (M3.6, KTD8) перенесённые берут группу страницы-цели: граница считается
  // здесь и уходит тем же `setEdits`, что порядок, — один шаг undo. Крайняя страница, брошенная
  // «через границу» рядом с собой, порядок не меняет, а группу — да: шлётся одна граница.
  // Склеенные обороты (B-13, R2, R6): едут за своими лицами, оборот без лица остаётся; бросок
  // «после» страницы ложится за её листом, бросок на оборот — перед его лицом или после листа;
  // бросок лица на свой оборот — ничего. Лист не разрывается.
  const move = (keys: readonly string[], target: string, side: DropSide): void => {
    if (!positions.has(target)) {
      return;
    }
    const moving = movingOf(keys, glued, visible);
    const drop = sheetDrop(target, side, moving, glued, visible);
    const targetIndex = drop === null ? undefined : positions.get(drop.key);
    if (drop === null || targetIndex === undefined) {
      return;
    }
    const base = moved(edits.current.edits, visible, moving, drop.key, drop.side);
    let next: SessionEdits | null = base;
    if (sets !== null) {
      const divider = dividerAfterMove(visible, sets.divider, moving, targetIndex);
      if (base !== null || divider !== sets.divider) {
        next = { ...(base ?? edits.current.edits), divider };
      }
    }
    if (next !== null) {
      sendMove(
        next,
        moving,
        keys.filter((key) => moving.includes(key)),
      );
    }
  };

  // Бросок на разделитель наборов или в пустую группу (S2–S3 M3.6): только граница, порядок —
  // если выделение к ней не прилегало.
  const moveAcross = (keys: readonly string[], side: SetSide): void => {
    if (sets === null) {
      return;
    }
    const next = movedAcross(edits.current.edits, visible, sets.divider, keys, side);
    if (next !== null) {
      sendMove(next, keys);
    }
  };

  return { move, moveAcross };
}
