// Rules of the grant picker (docs/ui-guide.md#rows-and-controls), kept free of React so
// tests/unit/grant-picker.test.js can check them directly.
//
// An entry is { id, name, sub?, group?, badge?, locked?, notes?, action? }: `sub` is the
// monospace line, `group` a project or group label, `locked` marks an entry that is
// always allowed (it cannot be switched off), `notes` are extra lines and `action` an
// optional { label, onClick }. `selected` is the list of explicitly granted ids; it may
// hold ids that no entry has any more, and those stay untouched.

/** Whether the entry is allowed: locked, or its id is in `selected`. */
export const isAllowed = (entry, selected) =>
  Boolean(entry.locked) || selected.includes(entry.id);

/** The allowed entries, in the order of `entries`. */
export const allowedEntries = (entries, selected) =>
  entries.filter((entry) => isAllowed(entry, selected));

/** A new list with `id` added once (appended) or removed; other ids keep their order. */
export function setGrant(selected, id, on) {
  if (!on) return selected.filter((item) => item !== id);
  return selected.includes(id) ? [...selected] : [...selected, id];
}

/** `selected` with every id of `ids` added. */
export const addGrants = (selected, ids) =>
  ids.reduce((next, id) => setGrant(next, id, true), [...selected]);

/** The entries as AddPicker candidates: only id, name, sub and group. */
export const grantCandidates = (entries) =>
  entries.map(({ id, name, sub, group }) => ({ id, name, sub, group }));
