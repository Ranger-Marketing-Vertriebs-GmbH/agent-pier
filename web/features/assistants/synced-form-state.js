// Pure comparisons behind useSyncedForm, kept separate so they can be unit-tested.
export const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// True while the form holds values the server does not have yet.
export function isDirty(values, base) {
  const keys = new Set([...Object.keys(values), ...Object.keys(base)]);
  for (const key of keys) if (!sameValue(values[key], base[key])) return true;
  return false;
}
