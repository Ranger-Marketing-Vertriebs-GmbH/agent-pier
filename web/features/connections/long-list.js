// The long list of a Zugänge category (SSH/SFTP accesses, MCP servers): fixed views,
// search, filter chips, grouping and sorting over normalised items, plus the
// selection that bulk actions work on. Pure, so 500 entries can be tested without a
// browser (tests/unit/connections-long-list.test.js).
//
// An item is { id, name, sub, group, search: [text], facets: { key: value | [values] },
//   problem: bool, used: true | false | null, lastUsedAt: ISO | null,
//   changedAt: ISO | null }. `used: null` means unknown: such an item is in no
//   "Nicht benutzt" view and is never counted as unused.

export const listViews = ["all", "problems", "unused", "today"];
export const listSorts = ["name", "changed", "used"];
// Each group shows this many rows until "Weitere n anzeigen".
export const groupPageSize = 5;
// Without grouping the one list starts with this many rows.
export const flatPageSize = 25;
export const ungrouped = "none";

export const initialListState = (groupBy = ungrouped) => ({
  view: "all",
  query: "",
  filters: {},
  groupBy,
  sort: "name",
  // Group key → true while collapsed; group key → true once all rows are shown.
  collapsed: {},
  expanded: {},
  selected: [],
});

const words = (query) => query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);

/** Whether `iso` falls on the same local day as `now`. */
export function sameDay(iso, now = new Date()) {
  if (!iso) return false;
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return false;
  return (
    time.getFullYear() === now.getFullYear() &&
    time.getMonth() === now.getMonth() &&
    time.getDate() === now.getDate()
  );
}

export function inView(item, view, now) {
  if (view === "problems") return item.problem === true;
  if (view === "unused") return item.used === false;
  if (view === "today") return sameDay(item.lastUsedAt, now);
  return true;
}

const facetMatches = (value, wanted) =>
  Array.isArray(value) ? value.includes(wanted) : value === wanted;

/** Active filters: keys with a chosen value ("" means all). */
export const activeFilters = (filters) =>
  Object.entries(filters || {}).filter(([, value]) => value !== "" && value != null);

export function matchesQuery(item, query) {
  const needles = words(query);
  if (!needles.length) return true;
  const haystack = (item.search || [])
    .filter((value) => typeof value === "string" && value)
    .join(" ")
    .toLocaleLowerCase();
  return needles.every((needle) => haystack.includes(needle));
}

export function matchesFilters(item, filters) {
  return activeFilters(filters).every(([key, wanted]) =>
    facetMatches(item.facets?.[key], wanted),
  );
}

/** Items of the current view that match the search and every filter. */
export function filterItems(items, state, now = new Date()) {
  return items.filter(
    (item) =>
      inView(item, state.view, now) &&
      matchesQuery(item, state.query) &&
      matchesFilters(item, state.filters),
  );
}

/** How many items each fixed view holds, before search and filters. */
export function viewCounts(items, now = new Date()) {
  return Object.fromEntries(
    listViews.map((view) => [
      view,
      items.filter((item) => inView(item, view, now)).length,
    ]),
  );
}

const byName = (a, b) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
  a.id.localeCompare(b.id);
// Newest first; items without a time come last, by name.
const byTime = (field) => (a, b) => {
  const left = a[field] ? Date.parse(a[field]) : NaN;
  const right = b[field] ? Date.parse(b[field]) : NaN;
  if (Number.isNaN(left) && Number.isNaN(right)) return byName(a, b);
  if (Number.isNaN(left)) return 1;
  if (Number.isNaN(right)) return -1;
  return right - left || byName(a, b);
};

export function sortItems(items, sort) {
  const compare =
    sort === "changed"
      ? byTime("changedAt")
      : sort === "used"
        ? byTime("lastUsedAt")
        : byName;
  return [...items].sort(compare);
}

/**
 * Groups in display order with the rows each shows: the first `groupPageSize` (or
 * `flatPageSize` without grouping) until the group is expanded. `groupOf(item)`
 * returns { key, label, order? }; groups sort by `order`, then label.
 */
export function groupItems(items, state, groupOf) {
  if (state.groupBy === ungrouped || !groupOf) {
    const shown = state.expanded[ungrouped] ? items.length : flatPageSize;
    return [
      {
        key: ungrouped,
        label: "",
        total: items.length,
        problems: items.filter((item) => item.problem).length,
        collapsed: false,
        rows: items.slice(0, shown),
        more: Math.max(0, items.length - shown),
      },
    ];
  }
  const groups = new Map();
  for (const item of items) {
    const { key, label, order = 0 } = groupOf(item, state.groupBy);
    if (!groups.has(key)) groups.set(key, { key, label, order, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()]
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
    .map(({ key, label, items: members }) => {
      const collapsed = state.collapsed[key] === true;
      const shown = state.expanded[key] ? members.length : groupPageSize;
      return {
        key,
        label,
        total: members.length,
        problems: members.filter((item) => item.problem).length,
        collapsed,
        rows: collapsed ? [] : members.slice(0, shown),
        more: collapsed ? 0 : Math.max(0, members.length - shown),
      };
    });
}

/** The ids of every row on screen, in order (keyboard moves, "select all visible"). */
export const visibleIds = (groups) =>
  groups.flatMap((group) => group.rows.map((r) => r.id));

/** The whole pipeline: filtered, sorted and grouped rows plus the counts around them. */
export function listModel(items, state, groupOf, now = new Date()) {
  const matching = sortItems(filterItems(items, state, now), state.sort);
  const groups = groupItems(matching, state, groupOf);
  return {
    total: items.length,
    matching: matching.length,
    problems: matching.filter((item) => item.problem).length,
    counts: viewCounts(items, now),
    groups,
    visible: visibleIds(groups),
  };
}

const toggled = (list, id) =>
  list.includes(id) ? list.filter((value) => value !== id) : [...list, id];

export function listReducer(state, action) {
  switch (action.type) {
    case "view":
      return { ...state, view: action.view, expanded: {} };
    case "query":
      return { ...state, query: action.query, expanded: {} };
    case "filter":
      return {
        ...state,
        filters: { ...state.filters, [action.key]: action.value },
        expanded: {},
      };
    case "reset":
      return { ...state, view: "all", query: "", filters: {}, expanded: {} };
    case "groupBy":
      return { ...state, groupBy: action.groupBy, collapsed: {}, expanded: {} };
    case "sort":
      return { ...state, sort: action.sort };
    case "collapse":
      return {
        ...state,
        collapsed: { ...state.collapsed, [action.key]: !state.collapsed[action.key] },
      };
    case "expand":
      return { ...state, expanded: { ...state.expanded, [action.key]: true } };
    case "select":
      return { ...state, selected: toggled(state.selected, action.id) };
    case "selectAll": {
      const all = action.ids.every((id) => state.selected.includes(id));
      return {
        ...state,
        selected: all
          ? state.selected.filter((id) => !action.ids.includes(id))
          : [...new Set([...state.selected, ...action.ids])],
      };
    }
    case "clearSelection":
      return { ...state, selected: [] };
    // Entries that are gone (deleted, reloaded) leave the selection.
    case "prune": {
      const selected = state.selected.filter((id) => action.ids.includes(id));
      return selected.length === state.selected.length ? state : { ...state, selected };
    }
    default:
      return state;
  }
}

/** The next row id for a key press on `current`, or null when the key does not move. */
export function nextRow(visible, current, key) {
  if (!visible.length) return null;
  const index = visible.indexOf(current);
  if (key === "Home") return visible[0];
  if (key === "End") return visible.at(-1);
  if (key === "ArrowDown")
    return visible[index < 0 ? 0 : Math.min(visible.length - 1, index + 1)];
  if (key === "ArrowUp") return visible[index <= 0 ? 0 : index - 1];
  return null;
}
