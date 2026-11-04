// Pure state of the review view: the comment editor's limits and keys, row selection
// in a diff region, and where a file's comments go.
import {
  anchorAt,
  locateAnchor,
  sideOf,
} from "../../../server/features/changes/review-anchor.js";

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

/**
 * What a new comment on `file.rows[index]` targets, captured when its editor opens so
 * a live refresh of the rows cannot move the draft: `{ workspace, file, side, line,
 * anchor }`, or null for a meta row.
 */
export function commentTarget({ workspace, file, index }) {
  const anchor = anchorAt(file.rows, index);
  if (!anchor) return null;
  return { workspace, file: file.path, side: anchor.side, line: anchor.line, anchor };
}

/** The payload for `onCreate`. */
export const commentInput = (target, body) => ({ ...target, body });

/**
 * `selected` is the highlighted row; `open` shows its comment action; `editing`
 * replaces the action with the editor (for the captured `target`) and pins the
 * selection.
 */
export const initialSelection = Object.freeze({
  selected: null,
  open: false,
  editing: false,
  target: null,
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
  return next === null
    ? null
    : { selected: next, open: false, editing: false, target: null };
}

/** A click or tap on a row selects it and shows its comment action. */
export function selectRow(state, index, rows) {
  if (state.editing || !selectable(rows[index])) return state;
  return { selected: index, open: true, editing: false, target: null };
}

/** "edit" opens the editor on the open row for `target`; "close" closes both. */
export function selectionAction(state, action, target = null) {
  if (action === "edit") {
    return state.open && target ? { ...state, editing: true, target } : state;
  }
  if (action === "close") return { ...state, open: false, editing: false, target: null };
  return state;
}

/**
 * New rows (a live refresh) clear a selection that is not editing; an open editor
 * follows its target's line, or stays open without a row (selected null) when the
 * line is gone, so the draft is never lost or moved.
 */
export function rowsChanged(state, rows) {
  if (!state.editing) return initialSelection;
  return { ...state, selected: locateAnchor(rows, state.target.anchor) };
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
