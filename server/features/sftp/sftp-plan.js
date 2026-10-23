import { createHash } from "node:crypto";
import { sftpProblem } from "./sftp-errors.js";
import { sftpLimits } from "./sftp-limits.js";
import { relativeParts } from "./sftp-remote-paths.js";

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * The key two names share when the target file system treats them as one file: NFC
 * always (APFS ignores normalization), lower-cased too for a case-insensitive target.
 */
export function pathKey(relative, { foldCase = false } = {}) {
  const nfc = relative.normalize("NFC");
  return foldCase ? nfc.toLowerCase() : nfc;
}

function checkedEntry(entry) {
  relativeParts(entry?.path);
  if (
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    !Number.isFinite(entry.mtimeMs)
  )
    throw new TypeError("Invalid SFTP plan entry.");
  return entry;
}

// Entries by key; two source entries with one key would land in one file.
function keyed(entries, foldCase, { unique }) {
  const byKey = new Map();
  for (const entry of entries.map(checkedEntry)) {
    const key = pathKey(entry.path, { foldCase });
    const same = byKey.get(key);
    if (same && unique)
      throw Object.assign(sftpProblem("SFTP_PATH_REFUSED"), {
        details: { collision: [same[0].path, entry.path] },
      });
    if (same) same.push(entry);
    else byKey.set(key, [entry]);
  }
  return byKey;
}

function changed(source, target, hashes) {
  if (hashes) {
    const [a, b] = [hashes.source.get(source.path), hashes.target.get(target.path)];
    return a === undefined || b === undefined || a !== b;
  }
  return (
    source.size !== target.size ||
    Math.abs(source.mtimeMs - target.mtimeMs) > sftpLimits.mtimeToleranceMs
  );
}

// JSON with sorted object keys, so equal plans and contexts hash equally.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

/**
 * Plans a transfer of `source` entries onto `target` entries. A copy writes every
 * source file; a sync writes only new and changed ones (size and mtime, or the given
 * hashes) and deletes target files missing from the source only with `deleteExtra`.
 * Names are matched by `pathKey` (`foldCase` for a case-insensitive target), and
 * source names sharing a key are refused. `digest` covers the caller's `context`
 * (direction, host and revision, roots), the options and the sorted plan, so an
 * approval never runs a different transfer.
 */
export function planTransfer({
  source,
  target,
  sync = false,
  deleteExtra = false,
  hashes = null,
  foldCase = false,
  context = null,
}) {
  const sources = keyed(source, foldCase, { unique: true });
  const targets = keyed(target, foldCase, { unique: false });
  const create = [],
    update = [];
  let unchanged = 0;
  for (const [key, [entry]] of sources) {
    const candidates = targets.get(key) || [];
    const existing =
      candidates.find((other) => other.path === entry.path) || candidates[0];
    if (!existing) create.push(entry);
    else if (!sync || changed(entry, existing, hashes)) update.push(entry);
    else unchanged++;
  }
  create.sort(byPath);
  update.sort(byPath);
  const remove =
    sync && deleteExtra
      ? [...targets]
          .filter(([key]) => !sources.has(key))
          .flatMap(([, entries]) => entries)
          .sort(byPath)
      : [];
  const tuple = (side) => (entry) => [
    entry.path,
    entry.size,
    entry.mtimeMs,
    hashes ? (hashes[side].get(entry.path) ?? null) : null,
  ];
  const digest = createHash("sha256")
    .update(
      canonical({
        context,
        sync,
        deleteExtra,
        hashed: Boolean(hashes),
        foldCase,
        entries: {
          create: create.map(tuple("source")),
          update: update.map(tuple("source")),
          delete: remove.map(tuple("target")),
        },
      }),
    )
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
