import { useState } from "react";

const empty = () => ({ selected: [], anchor: null });
export function reconcileSelection(state, entries) {
  const current = new Map(entries.map((item) => [item.path, item]));
  return {
    selected: state.selected.filter(
      (item) => current.get(item.path)?.revision === item.revision,
    ),
    anchor: current.has(state.anchor) ? state.anchor : null,
  };
}
export function selectionChange(state, entries, action, path) {
  state = reconcileSelection(state, entries);
  if (action === "clear") return empty();
  const entry = entries.find((item) => item.path === path);
  if (!entry) return state;
  if (action === "range" && state.anchor) {
    const start = entries.findIndex((item) => item.path === state.anchor);
    const end = entries.indexOf(entry);
    return {
      selected: entries.slice(Math.min(start, end), Math.max(start, end) + 1),
      anchor: state.anchor,
    };
  }
  return {
    anchor: path,
    selected:
      action === "toggle"
        ? state.selected.some((item) => item.path === path)
          ? state.selected.filter((item) => item.path !== path)
          : [...state.selected, entry]
        : [entry],
  };
}
export default function useFileSelection(entries, owner = entries) {
  const [stored, set] = useState({ owner, entries, ...empty() });
  const state = stored.owner === owner ? reconcileSelection(stored, entries) : empty();
  const change = (action, path) =>
    set((prior) => ({
      owner,
      entries,
      ...selectionChange(prior.owner === owner ? prior : empty(), entries, action, path),
    }));
  return {
    ...state,
    entries,
    select: (path) => change("select", path),
    range: (path) => change("range", path),
    toggle: (path) => change("toggle", path),
    clear: () => change("clear"),
  };
}
