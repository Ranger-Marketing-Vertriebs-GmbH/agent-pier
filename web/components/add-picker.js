// State and rules of the inline add field (AddPicker.jsx, docs/ui-guide.md#rows-and-controls),
// kept free of React so tests/unit/add-picker.test.js can check them directly.
//
// A candidate is { id, name, sub?, group?, granted? }: `sub` is the monospace line (host,
// package, path), `group` a project or group label, `granted` marks what the owner
// already has, which stays visible but cannot be chosen.

/** Rows rendered at once; the rest is counted ("n more – refine the search"). */
export const defaultRowLimit = 50;
/** Delay before an async `search(query)` runs, in milliseconds. */
export const searchDelay = 250;

const fold = (text) => String(text ?? "").toLocaleLowerCase();

/** Candidates with `granted` set for every id in `granted` (an array or Set). */
export function markGranted(candidates, granted = []) {
  const ids = new Set(granted);
  if (!ids.size) return candidates;
  return candidates.map((candidate) =>
    ids.has(candidate.id) ? { ...candidate, granted: true } : candidate,
  );
}

/** Candidates whose name, sub line or group contain every word of `query`. */
export function filterCandidates(candidates, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return candidates;
  return candidates.filter((candidate) => {
    const text = [candidate.name, candidate.sub, candidate.group].map(fold).join(" ");
    return words.every((word) => text.includes(word));
  });
}

/** The first `limit` matches and how many are left out. */
export function visibleRows(matches, limit = defaultRowLimit) {
  return { rows: matches.slice(0, limit), hidden: Math.max(0, matches.length - limit) };
}

export const isSelectable = (candidate) => Boolean(candidate) && !candidate.granted;

export function initialPickerState(mode = null) {
  return { query: "", open: false, active: -1, selected: [], mode };
}

const isSelected = (state, id) => state.selected.some((item) => item.id === id);

function toggle(state, candidate) {
  if (!isSelectable(candidate)) return state;
  const selected = isSelected(state, candidate.id)
    ? state.selected.filter((item) => item.id !== candidate.id)
    : [...state.selected, candidate];
  return { ...state, selected };
}

/** The row index the active option moves to; disabled rows are skipped. */
export function moveActive(rows, active, intent) {
  const enabled = rows.flatMap((row, index) => (isSelectable(row) ? [index] : []));
  if (!enabled.length) return -1;
  if (intent === "first") return enabled[0];
  if (intent === "last") return enabled.at(-1);
  if (intent === "next")
    return active < 0 ? enabled[0] : (enabled.find((index) => index > active) ?? active);
  if (intent === "previous")
    return active < 0
      ? enabled.at(-1)
      : (enabled.findLast((index) => index < active) ?? active);
  return active;
}

/**
 * The picker's reducer. Actions: `query` (typing opens the list and clears the active
 * option), `open`, `close`, `move` (with `intent` and the rendered `rows`), `toggle`
 * (a `candidate`), `toggleActive` (with `rows`), `mode`, `reset` (after adding or
 * cancelling; the mode stays for the next items).
 */
export function pickerReducer(state, action) {
  switch (action.type) {
    case "query":
      return { ...state, query: action.query, open: true, active: -1 };
    case "open":
      return state.open ? state : { ...state, open: true, active: -1 };
    case "close":
      return { ...state, open: false, active: -1 };
    case "move": {
      if (!state.open) {
        // The first arrow opens the list; the next one moves into it.
        return { ...state, open: true, active: -1 };
      }
      return { ...state, active: moveActive(action.rows, state.active, action.intent) };
    }
    case "toggle":
      return toggle(state, action.candidate);
    case "toggleActive":
      return toggle(state, action.rows[state.active]);
    case "mode":
      return { ...state, mode: action.mode };
    case "reset":
      return initialPickerState(state.mode);
    default:
      return state;
  }
}

/**
 * What a key in the field means: `next`, `previous`, `first`, `last`, `toggle`, `add`,
 * `close`, `clear`, or null to let the field handle it (typing, caret moves). Space
 * and Home/End act on the list only while an option is active, so names with spaces
 * can still be typed.
 */
export function keyIntent(key, { open, active }) {
  const inList = open && active >= 0;
  if (key === "ArrowDown") return "next";
  if (key === "ArrowUp") return "previous";
  if (key === "Home" && inList) return "first";
  if (key === "End" && inList) return "last";
  if (key === " " && inList) return "toggle";
  if (key === "Enter" && open) return "add";
  if (key === "Escape") return open ? "close" : "clear";
  return null;
}

/** What Enter adds: the checked items, else the active option alone. */
export function itemsToAdd(state, rows) {
  if (state.selected.length) return state.selected;
  const active = rows[state.active];
  return isSelectable(active) ? [active] : [];
}
