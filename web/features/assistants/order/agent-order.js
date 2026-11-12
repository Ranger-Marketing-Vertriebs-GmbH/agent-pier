// A person's own order of her agent list (server agent-order.js): the pure parts of
// sorting, moving and dropping. An entry is `{ id, section, kind, fixed }`: `section` is the
// group it is listed in ("ungrouped" without one), `kind` keeps the owner's agents
// apart from the users' agents shown under their own heading. A move only changes the
// order inside one section and kind; `display` is every entry in the order shown.

/** `items` (with `id`) sorted by `order`; the rest keep their order after them. */
export function sortByOrder(items, order = []) {
  const rank = new Map(order.map((id, index) => [id, index]));
  const at = (item) => rank.get(item.id) ?? Infinity;
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => at(a.item) - at(b.item) || a.index - b.index)
    .map(({ item }) => item);
}

const bucket = (display, entry, section = entry.section) =>
  display.filter((other) => other.section === section && other.kind === entry.kind);

/**
 * The ids in their new order once `id` lands in `section` before `beforeId` (null:
 * after the last of its kind there), or null when nothing would change.
 */
export function placeAgent(display, id, { section, beforeId = null }) {
  const entry = display.find((other) => other.id === id);
  // A permanent member shown on its own follows its lead's group: it stays put.
  if (!entry || beforeId === id || (entry.fixed && section !== entry.section))
    return null;
  const rest = display.filter((other) => other.id !== id);
  const moved = { ...entry, section };
  let index;
  if (beforeId) index = rest.findIndex((other) => other.id === beforeId);
  else {
    const last = bucket(rest, moved).at(-1);
    index = last ? rest.indexOf(last) + 1 : rest.length;
  }
  if (index < 0) return null;
  const next = [...rest.slice(0, index), moved, ...rest.slice(index)];
  const same = (list) => bucket(list, moved, section).map((other) => other.id);
  if (section === entry.section && same(next).join("\n") === same(display).join("\n"))
    return null;
  return next.map((other) => other.id);
}

/** The ids with `id` one step "up" or "down" in its section and kind, or null. */
export function stepAgent(display, id, direction) {
  const entry = display.find((other) => other.id === id);
  if (!entry) return null;
  const peers = bucket(display, entry);
  const index = peers.indexOf(entry);
  if (direction === "up")
    return index > 0
      ? placeAgent(display, id, { section: entry.section, beforeId: peers[index - 1].id })
      : null;
  if (index < 0 || index >= peers.length - 1) return null;
  return placeAgent(display, id, {
    section: entry.section,
    beforeId: peers[index + 2]?.id ?? null,
  });
}

/** Its position in its section and kind (from 1) and that list's length. */
export function positionOf(display, id) {
  const entry = display.find((other) => other.id === id);
  if (!entry) return null;
  const peers = bucket(display, entry);
  return { position: peers.indexOf(entry) + 1, count: peers.length };
}

/**
 * Where a drop at height `y` lands, or null outside every section. `rows` are the
 * shown rows `{ id, section, kind, top, bottom }` (a folded section shows none),
 * `sections` the sections `{ key, top, bottom }`, both in viewport coordinates. The
 * dragged agent lands before the first row of its kind in the section under `y`
 * whose middle is below `y`, else after the last one: `{ section, beforeId,
 * afterId }`, where `afterId` names that last row (null in a section without one).
 */
export function dropTarget({ source, rows, sections, y }) {
  const section = sections.find((entry) => y >= entry.top && y < entry.bottom);
  if (!source || !section) return null;
  const peers = rows.filter(
    (row) =>
      row.section === section.key && row.kind === source.kind && row.bottom > row.top,
  );
  const before = peers.find((row) => y < (row.top + row.bottom) / 2);
  return {
    section: section.key,
    beforeId: before?.id ?? null,
    afterId: before ? null : (peers.at(-1)?.id ?? null),
  };
}

export const sameTarget = (a, b) =>
  a === b ||
  (!!a &&
    !!b &&
    a.section === b.section &&
    a.beforeId === b.beforeId &&
    a.afterId === b.afterId);

/**
 * The owner's agent list in his order: his own agents by `order`, then the agents of
 * users, which keep their own heading below his.
 */
export const ownerSorted = (agents, order) =>
  sortByOrder(agents, order).sort(
    (a, b) => Boolean(a.userAccess) - Boolean(b.userAccess),
  );

/** The key of an agent group's section (group-view.js areaSections). */
export const sectionKey = (section) => section.group?.id || "ungrouped";

/**
 * The entries of the owner's list: the sorted agents of each section `{ group,
 * agents }` (members shown under their lead left out). A team member listed on its own
 * (its lead archived) follows its lead's group: it is `fixed`.
 */
export const ownerEntries = (sections) =>
  sections.flatMap((section) =>
    section.agents.map((a) => ({
      id: a.id,
      name: a.name,
      section: sectionKey(section),
      kind: a.userAccess ? "user" : "own",
      fixed: Boolean(a.teamMemberId),
    })),
  );
