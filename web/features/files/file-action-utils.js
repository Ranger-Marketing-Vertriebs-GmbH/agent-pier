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
// The ZIP's file name: one selected entry names it, several take the folder's name.
export function archiveName(items, folderPath = "") {
  const base = (value) =>
    String(value || "")
      .split("/")
      .filter(Boolean)
      .at(-1);
  const name = (items.length === 1 ? base(items[0].path) : null) || base(folderPath);
  return name ? `${name.replace(/\.zip$/i, "")}.zip` : "archive.zip";
}
// "source → destination" only when the entry went somewhere else: a trashed entry
// or one without a recorded source names its path once.
export function outcomePath(job, entry) {
  const destination = job.kind === "archive" ? entry.name || entry.path : entry.path;
  return job.kind !== "restore" && entry.source && entry.source !== destination
    ? `${entry.source} → ${destination}`
    : destination;
}

// Whether `path` is `folder` or lies inside it ("" is a project's root).
export function containsPath(folder, path) {
  if (typeof path !== "string") return false;
  if (folder === "" || folder === path) return true;
  return path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);
}
