import { browserUuid } from "../../lib/browser-uuid.js";

export const requestId = () => `${Date.now()}:${browserUuid()}`;
export const operation = (
  kind,
  sources = [],
  target = null,
  name = null,
  options = {},
) => ({ requestId: requestId(), kind, sources, target, name, options });
export const references = (items) =>
  items.map(({ path, revision }) => ({ path, revision }));
export const transferOperation = (kind, items, target) =>
  operation(
    kind,
    items.map((item) => item.path),
    target,
    null,
    { revisions: Object.fromEntries(items.map((item) => [item.path, item.revision])) },
  );
export const bytes = (body) => new TextEncoder().encode(JSON.stringify(body)).length;
export function purgeBatches(entries) {
  const result = [];
  let batch = operation("purge", [], null, null, { confirmation: [] });
  for (const entry of entries) {
    const next = {
      ...batch,
      sources: [...batch.sources, entry.id],
      options: {
        confirmation: [
          ...batch.options.confirmation,
          { id: entry.id, revision: entry.revision },
        ],
      },
    };
    if (bytes(next) > 64 * 1024) {
      if (!batch.sources.length) throw new RangeError("FILE_LIMIT_EXCEEDED");
      result.push(batch);
      batch = operation("purge", [entry.id], null, null, {
        confirmation: [{ id: entry.id, revision: entry.revision }],
      });
      if (bytes(batch) > 64 * 1024) throw new RangeError("FILE_LIMIT_EXCEEDED");
    } else batch = next;
  }
  if (batch.sources.length) result.push(batch);
  return result;
}
export const isTerminal = (job) =>
  job &&
  !["queued", "running", "waiting_for_conflict", "cancelling"].includes(job.status);
