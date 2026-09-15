import path from "node:path";
import { createHash } from "node:crypto";
import { appendFilePath, resolveFile, entryRevision } from "./file-paths.js";
import { fileProblem } from "./file-errors.js";
import { observeRetryDestinations } from "./file-retry-targets.js";

export const retryUnavailable = () => fileProblem("FILE_RETRY_UNAVAILABLE", 409);
const unfinished = (row) =>
  !["completed", "skipped"].includes(row.status) &&
  !row.outputPublished &&
  !row.sourceRemoved &&
  !row.sourceRemovalPending;
function ancestors(value) {
  const result = [];
  for (
    let parent = path.posix.dirname(value);
    parent !== value;
    parent = path.posix.dirname(parent)
  ) {
    result.push(parent);
    value = parent;
  }
  return result;
}
export const retryRows = (store, id) =>
  store.db
    .prepare("SELECT document FROM job_entries WHERE job_id=? ORDER BY sequence")
    .all(id)
    .map((row) => JSON.parse(row.document));

export function assertRetryOwner(owner, scope, id, childId = null) {
  const job = owner.jobs.get(scope, id);
  if (
    !["failed", "cancelled", "interrupted", "partially_completed"].includes(job.status) ||
    owner.jobs.owns(id) ||
    job.uploadGroupId ||
    owner.store.db
      .prepare(
        "SELECT id FROM jobs WHERE parent_job_id=? AND entry_id LIKE 'retry:%' AND id!=? LIMIT 1",
      )
      .get(id, childId || "") ||
    owner.store.db
      .prepare("SELECT id FROM publications WHERE job_id=? AND phase!='resolved' LIMIT 1")
      .get(id)
  )
    throw retryUnavailable();
  return job;
}

// Exclude a directory containing any successful or deliberately skipped descendant.
// Remaining children keep their original effective targets; no completed tree is replayed.
function remainingRoots(rows, key) {
  const excluded = new Set(
    rows
      .filter((row) => !unfinished(row) && row[key])
      .flatMap((row) => ancestors(row[key])),
  );
  const candidates = rows.filter(
    (row) =>
      unfinished(row) &&
      row[key] &&
      (row.type !== "directory" || !excluded.has(row[key])),
  );
  const directories = new Set(
    candidates.filter((row) => row.type === "directory").map((row) => row[key]),
  );
  return candidates.filter(
    (row) => !ancestors(row[key]).some((parent) => directories.has(parent)),
  );
}
const coveredBy = (roots, key) => {
  const selected = new Set(roots.map((row) => row[key])),
    directories = new Set(
      roots.filter((row) => row.type === "directory").map((row) => row[key]),
    );
  return (row) =>
    row[key] &&
    (selected.has(row[key]) ||
      ancestors(row[key]).some((parent) => directories.has(parent)));
};

async function observeSource(scope, source, expected, tree = false) {
  const selected = await resolveFile(scope, source, { followLeaf: false });
  const revision = entryRevision(selected.stat, selected.linkIdentity);
  const contentRevision = entryRevision(selected.stat);
  if (expected && (tree ? contentRevision : revision) !== expected)
    throw retryUnavailable();
  return {
    source,
    revision,
    contentRevision,
    absolute: selected.absolute,
    linkIdentity: selected.linkIdentity,
  };
}

export async function planRetry(owner, scope, id, childId) {
  const job = assertRetryOwner(owner, scope, id, childId),
    original = owner.store.getOperation(id),
    rows = retryRows(owner.store, id),
    operation = structuredClone(original),
    pins = [],
    targets = [],
    entries = [];
  delete operation.parentJobId;
  delete operation.entryId;
  const addSource = async (source, expected, tree) => {
    const pin = await observeSource(scope, source, expected, tree);
    pins.push(pin);
    return pin;
  };
  if (["copy", "move"].includes(job.kind)) {
    if (!rows.length) throw retryUnavailable();
    const roots = remainingRoots(rows, "source").filter((row) =>
      /^e1:[a-f0-9]{64}$/.test(row.revision),
    );
    operation.sources = roots.map((row) => row.source);
    operation.options = { revisions: {} };
    for (const row of roots) {
      const pin = await addSource(row.source, row.revision, true);
      operation.options.revisions[row.source] = pin.revision;
      targets.push({ source: row.source, path: row.path });
      entries.push({ id: row.id, source: row.source, path: row.path, type: row.type });
    }
    const rootPaths = new Set(roots.map((row) => row.source));
    for (const row of rows
      .filter(coveredBy(roots, "source"))
      .filter((row) => !rootPaths.has(row.source)))
      await addSource(row.source, row.revision, true);
  } else if (job.kind === "extract") {
    const observation = owner.store.jobDetails(id).extractSource;
    if (!observation || !rows.length) throw retryUnavailable();
    const pin = await addSource(original.sources[0], observation.revision);
    if (
      pin.absolute !== observation.absolute ||
      pin.linkIdentity !== observation.linkIdentity
    )
      throw retryUnavailable();
    const roots = remainingRoots(rows, "relative");
    for (const row of rows.filter(coveredBy(roots, "relative"))) {
      targets.push({ relative: row.relative, path: row.path });
      entries.push({ id: row.id, source: row.source, path: row.path, type: row.type });
    }
  } else if (
    ["archive", "rename", "create_file", "create_directory", "search", "size"].includes(
      job.kind,
    )
  ) {
    // A one-output operation cannot be reconstructed from a partly successful plan.
    if (
      rows.some((row) => !unfinished(row) && row.status !== "skipped") ||
      owner.store.db.prepare("SELECT id FROM publications WHERE job_id=? LIMIT 1").get(id)
    )
      throw retryUnavailable();
    for (const source of original.sources) {
      await addSource(source, original.options.revisions?.[source]);
      entries.push({
        id: String(entries.length),
        source,
        path:
          job.kind === "rename"
            ? appendFilePath(path.dirname(source), original.name)
            : job.kind === "archive" && original.options.output === "file"
              ? appendFilePath(original.target, original.name)
              : source,
      });
    }
    if (!original.sources.length)
      entries.push({ id: "0", path: appendFilePath(original.target, original.name) });
  } else if (["trash", "restore", "purge"].includes(job.kind)) {
    if (!rows.length) throw retryUnavailable();
    const remaining = rows.filter(unfinished);
    operation.sources = remaining.map((row) => row.source);
    const confirmation = [];
    for (const row of remaining) {
      if (job.kind === "trash") {
        const pin = await addSource(row.source);
        const retained = owner.store.db
          .prepare("SELECT document FROM trash_entries WHERE job_id=?")
          .all(id);
        if (
          retained.some(
            (item) => JSON.parse(item.document).originalAbsolute === pin.absolute,
          )
        )
          throw retryUnavailable();
      } else {
        const observed = await owner.trash.observe(
          owner.trash.authorized(scope, row.source),
        );
        if (observed.availability !== "recoverable") throw retryUnavailable();
        pins.push({ trashId: row.source, revision: observed.revision });
        confirmation.push({ id: row.source, revision: observed.revision });
      }
      entries.push({
        id: row.id,
        source: job.kind === "trash" ? row.source : row.path,
        path: job.kind === "restore" ? original.target : row.path,
        type: row.type,
      });
    }
    if (job.kind === "purge") operation.options = { confirmation };
    if (job.kind === "restore") operation.options = {};
  } else throw retryUnavailable();
  if (!entries.length || entries.length > owner.store.limits.jobEntries)
    throw retryUnavailable();
  const destinations = await observeRetryDestinations(
    scope,
    [
      "copy",
      "move",
      "extract",
      "restore",
      "rename",
      "create_file",
      "create_directory",
    ].includes(job.kind) ||
      (job.kind === "archive" && original.options.output === "file")
      ? entries.map((row) => row.path)
      : [],
  );
  // Bind the proposal to the complete terminal evidence, immutable original request,
  // and current source observations. Only this digest and safe entries cross HTTP.
  const hash = createHash("sha256");
  for (const value of [
    scope.id,
    id,
    job.status,
    original,
    operation,
    ...rows,
    ...pins,
    ...targets,
    ...destinations,
  ])
    hash.update(JSON.stringify(value)).update("\n");
  const reference = `r1:${hash.digest("hex")}`;
  assertRetryOwner(owner, scope, id, childId);
  return { reference, operation, pins, targets, destinations, entries };
}
