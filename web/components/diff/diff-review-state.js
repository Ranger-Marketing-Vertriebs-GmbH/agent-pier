// Pure state of the review view: the comment editor's limits and keys, row selection
// in a diff region, and where a file's comments go.
import { anchorAt, sideOf } from "../../../server/features/changes/review-anchor.js";

/** Matches the server's limit (server/features/changes/review-comment-input.js). */
export const MAX_COMMENT_BYTES = 8192;
/** The count shows from this many bytes on. */
const NEAR_LIMIT_BYTES = MAX_COMMENT_BYTES - 1024;
/** Rows a file shows at first and adds per "Show more". */
export const ROW_PAGE = 400;

const encoder = new TextEncoder();

export function editorState(text) {
  const bytes = encoder.encode(text).length;
  const blank = text.trim() === "";
  const tooLong = bytes > MAX_COMMENT_BYTES;
  return {
    bytes,
    blank,
    tooLong,
    nearLimit: bytes >= NEAR_LIMIT_BYTES,
    canSave: !blank && !tooLong,
  };
}

/** @returns {"save" | "cancel" | null} */
export function editorKey(event) {
  if (event.isComposing) return null;
  if (event.key === "Escape") return "cancel";
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) return "save";
  return null;
}

/** The line of a code row on its own side, or null for a meta row. */
export function rowLine(row) {
  const side = row ? sideOf(row) : null;
  if (!side) return null;
  return side === "old" ? row.oldLine : row.newLine;
}

/** The payload for `onCreate`, anchored at `rows[index]`. */
export function commentInput({ workspace, file, index, body }) {
  const anchor = anchorAt(file.rows, index);
  return {
    workspace,
    file: file.path,
    side: anchor.side,
    line: anchor.line,
    anchor,
    body,
  };
}

/**
 * `selected` is the highlighted row; `open` shows its comment action; `editing`
 * replaces the action with the editor and pins the selection.
 */
export const initialSelection = Object.freeze({
  selected: null,
  open: false,
  editing: false,
});

const selectable = (row) => Boolean(row) && sideOf(row) !== null;

function step(rows, from, direction) {
  for (let i = from + direction; i >= 0 && i < rows.length; i += direction) {
    if (selectable(rows[i])) return i;
  }
  return null;
}

/** The new state for a key in the diff region, or null when the key is not handled. */
export function selectionKey(state, key, rows) {
  if (state.editing) return null;
  const { selected } = state;
  let next = null;
  if (key === "ArrowDown") {
    next = selected === null ? step(rows, -1, 1) : (step(rows, selected, 1) ?? selected);
  } else if (key === "ArrowUp") {
    next =
      selected === null
        ? step(rows, rows.length, -1)
        : (step(rows, selected, -1) ?? selected);
  } else if (key === "Home") {
    next = step(rows, -1, 1);
  } else if (key === "End") {
    next = step(rows, rows.length, -1);
  } else if (key === "Enter") {
    return selected === null ? null : { ...state, open: true };
  } else if (key === "Escape") {
    return state.open ? { ...state, open: false } : null;
  } else {
    return null;
  }
  return next === null ? null : { selected: next, open: false, editing: false };
}

/** A click or tap on a row selects it and shows its comment action. */
export function selectRow(state, index, rows) {
  if (state.editing || !selectable(rows[index])) return state;
  return { selected: index, open: true, editing: false };
}

/** "edit" opens the editor on the open row; "close" closes action and editor. */
export function selectionAction(state, action) {
  if (action === "edit") return state.open ? { ...state, editing: true } : state;
  if (action === "close") return { ...state, open: false, editing: false };
  return state;
}

/**
 * Where a file's comments go when the first `shown` rows are rendered: `after` maps a
 * shown row index to its threads, `hidden` lists comments whose row exists but is not
 * shown yet (with its line), `outdated` those whose line is gone. Outdated is decided
 * by placeComments against all parsed rows, never the shown page.
 */
export function fileCommentLayout(entry, rows, shown) {
  const after = new Map();
  const hidden = [];
  for (const { comment, index } of entry?.placed ?? []) {
    if (index < shown) {
      if (!after.has(index)) after.set(index, []);
      after.get(index).push(comment);
    } else {
      hidden.push({ comment, line: rowLine(rows[index]) });
    }
  }
  return { after, hidden, outdated: entry?.outdated ?? [] };
}
