// Pure rules behind settings drafts (useTabDraft, useSyncedForm). A draft holds the
// edited `values` and the `base` they were edited from; the base follows the server
// for fields the owner did not touch.
export const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function changedKeys(values, base) {
  const keys = new Set([...Object.keys(values), ...Object.keys(base)]);
  return [...keys].filter((key) => !sameValue(values[key], base[key]));
}

export const isDirty = (values, base) => changedKeys(values, base).length > 0;

/**
 * Applies a newer server record: untouched fields adopt it, edited fields stay, and an
 * edited field the server changed as well is reported as a conflict.
 */
export function followServer({ values, base }, server) {
  const nextValues = { ...values };
  const nextBase = { ...base };
  const conflicts = [];
  for (const key of Object.keys(server)) {
    if (sameValue(nextValues[key], server[key])) nextBase[key] = server[key];
    else if (sameValue(server[key], nextBase[key])) continue;
    else if (sameValue(nextValues[key], nextBase[key])) {
      nextValues[key] = server[key];
      nextBase[key] = server[key];
    } else conflicts.push(key);
  }
  return {
    values: sameValue(nextValues, values) ? values : nextValues,
    base: sameValue(nextBase, base) ? base : nextBase,
    conflicts,
  };
}

/** The saved snapshot of `keys` becomes their new base. */
export function markSaved(base, values, keys) {
  const next = { ...base };
  for (const key of keys) next[key] = values[key];
  return next;
}

/** Revisions only grow: a response can be newer than the props that follow it. */
export function followRevisions(current, latest) {
  const next = { ...current };
  for (const [resource, revision] of Object.entries(latest || {}))
    next[resource] =
      Number.isSafeInteger(revision) && Number.isSafeInteger(next[resource])
        ? Math.max(revision, next[resource])
        : revision;
  return next;
}

/**
 * Settles a draft after a save chain. `draft` is the draft now (it may have followed
 * the server or taken edits while the save ran), `submitted` the values sent, `before`
 * the server record when the save started and `server` the latest one. Only `savedKeys`
 * settle (all keys after a complete save, the finished steps' keys after a partial
 * one). A saved key re-adopts the server where it already reflects the save; otherwise
 * the submitted value stands until the server changes, so nothing flickers back to the
 * pre-save record. Fields edited during the save keep the newer edit.
 */
export function settleSave({ draft, submitted, savedKeys, before, server }) {
  const values = { ...draft.values };
  const base = { ...draft.base };
  for (const key of savedKeys) {
    const moved = key in server && !sameValue(server[key], before[key]);
    const stored = moved ? server[key] : submitted[key];
    const edited =
      !sameValue(values[key], submitted[key]) && !sameValue(values[key], stored);
    base[key] = stored;
    if (!edited) values[key] = stored;
  }
  return {
    values: sameValue(values, draft.values) ? draft.values : values,
    base: sameValue(base, draft.base) ? draft.base : base,
  };
}
