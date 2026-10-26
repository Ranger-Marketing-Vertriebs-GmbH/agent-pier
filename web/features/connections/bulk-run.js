// Bulk actions in Zugänge call the existing per-item endpoints one after the other (or
// at most `parallel` at once) and report one result per item. A failed item is
// reported, never retried: the owner decides what to repeat.

/**
 * Runs `work(item, index)` for every item with at most `parallel` running at once.
 * Resolves `[{ item, ok, value?, error? }]` in the items' order; `onProgress(done,
 * total, result)` hears each settled item.
 */
export async function runEach(items, work, { parallel = 1, onProgress } = {}) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  const lanes = Math.max(1, Math.min(parallel, items.length));
  async function lane() {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      let result;
      try {
        result = { item, ok: true, value: await work(item, index) };
      } catch (error) {
        result = { item, ok: false, error };
      }
      results[index] = result;
      done += 1;
      onProgress?.(done, items.length, result);
    }
  }
  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}

/** Counts of a finished run. */
export const runSummary = (results) => ({
  ok: results.filter((result) => result.ok).length,
  failed: results.filter((result) => !result.ok).length,
});
