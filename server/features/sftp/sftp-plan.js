import { createHash } from "node:crypto";
import { sftpProblem } from "./sftp-errors.js";
import { sftpLimits } from "./sftp-limits.js";

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const tuple = (entry) => [entry.path, entry.size, entry.mtimeMs];

function changed(source, target, hashes) {
  if (hashes) {
    const [a, b] = [hashes.source.get(source.path), hashes.target.get(source.path)];
    return a === undefined || b === undefined || a !== b;
  }
  return (
    source.size !== target.size ||
    Math.abs(source.mtimeMs - target.mtimeMs) > sftpLimits.mtimeToleranceMs
  );
}

/**
 * Plans a transfer of `source` entries onto `target` entries. A copy writes every
 * source file; a sync writes only new and changed ones (size and mtime, or the given
 * hashes) and deletes target files missing from the source only with `deleteExtra`.
 * `digest` covers the sorted plan, so a changed tree is noticed before it runs.
 */
export function planTransfer({
  source,
  target,
  sync = false,
  deleteExtra = false,
  hashes = null,
}) {
  const targets = new Map(target.map((entry) => [entry.path, entry]));
  const create = [],
    update = [];
  let unchanged = 0;
  for (const entry of [...source].sort(byPath)) {
    const existing = targets.get(entry.path);
    if (!existing) create.push(entry);
    else if (!sync || changed(entry, existing, hashes)) update.push(entry);
    else unchanged++;
  }
  const sources = new Set(source.map((entry) => entry.path));
  const remove =
    sync && deleteExtra
      ? target.filter((entry) => !sources.has(entry.path)).sort(byPath)
      : [];
  const digest = createHash("sha256")
    .update(JSON.stringify([create, update, remove].map((list) => list.map(tuple))))
    .digest("hex");
  return {
    create,
    update,
    delete: remove,
    unchanged,
    files: create.length + update.length,
    bytes: [...create, ...update].reduce((sum, entry) => sum + entry.size, 0),
    overwrites: update.length,
    deletes: remove.length,
    digest,
  };
}

/** Refuses a plan over the file or byte cap with `SFTP_LIMIT`. */
export function capPlan(plan, limits = sftpLimits) {
  if (plan.files > limits.maxFiles || plan.bytes > limits.maxBytes)
    throw Object.assign(sftpProblem("SFTP_LIMIT"), {
      details: { files: plan.files, bytes: plan.bytes },
    });
  return plan;
}

/** The plan for an approval card: paths capped at `listLimit` per list. */
export function planSummary(plan, listLimit = sftpLimits.planListLimit) {
  const list = (entries) => entries.slice(0, listLimit).map((entry) => entry.path);
  const more = (entries) => Math.max(0, entries.length - listLimit);
  return {
    create: list(plan.create),
    update: list(plan.update),
    delete: list(plan.delete),
    more: {
      create: more(plan.create),
      update: more(plan.update),
      delete: more(plan.delete),
    },
    files: plan.files,
    bytes: plan.bytes,
    overwrites: plan.overwrites,
    deletes: plan.deletes,
  };
}
