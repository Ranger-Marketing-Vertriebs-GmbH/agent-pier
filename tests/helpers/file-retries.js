import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { uploadRequest } from "./file-uploads.js";
import { extractionZip, extractOperation } from "./file-extract.js";
import { fileProblem } from "../../server/features/files/file-errors.js";
import { entryRevision, resolveFile } from "../../server/features/files/file-paths.js";

export const retryOperation = (kind, sources, target, extra = {}) => ({
  requestId: uploadRequest(),
  kind,
  sources,
  target,
  name: null,
  options: {},
  ...extra,
});
export async function retrySettled(f, job) {
  await f.until(() => !f.jobs.owns(job.id));
  return f.jobs.get(f.scope, job.id);
}
export async function failedRetry(f, kind) {
  const parent = path.join(f.project, "destination");
  await fs.mkdir(parent);
  const source = path.join(kind === "rename" ? parent : f.home, "original.txt");
  await fs.writeFile(source, "original bytes");
  let target = path.join(parent, kind === "archive" ? "chosen.zip" : "chosen.txt");
  let op = retryOperation(kind, [source], parent);
  if (["copy", "move"].includes(kind)) target = path.join(parent, "original.txt");
  if (["create_file", "create_directory", "archive"].includes(kind)) {
    op.name = path.basename(target);
    if (kind === "archive") op.options = { output: "file" };
    else op.sources = [];
  }
  if (kind === "rename") {
    const selected = await resolveFile(f.scope, source);
    op = retryOperation(kind, [source], null, {
      name: path.basename(target),
      options: {
        revisions: { [source]: entryRevision(selected.stat, selected.linkIdentity) },
      },
    });
  }
  if (kind === "restore") {
    const captured = await f.jobs.start(f.scope, retryOperation("trash", [source], null));
    assert.equal((await retrySettled(f, captured)).status, "completed");
    const { id } = f.store.db
      .prepare("SELECT id FROM trash_entries WHERE job_id=?")
      .get(captured.id);
    op = retryOperation(kind, [id], target);
  }
  const owner = kind === "restore" ? f.trash : f.publisher;
  const method =
    kind === "restore"
      ? "restore"
      : ["rename", "move"].includes(kind)
        ? "rename"
        : "stage";
  const actual = owner[method].bind(owner);
  owner[method] = async () => {
    throw fileProblem("FILE_ACCESS_DENIED", 403);
  };
  const job = await f.jobs.start(f.scope, op);
  assert.equal((await retrySettled(f, job)).status, "failed");
  owner[method] = actual;
  return { job, source, target, parent, op };
}
export async function failedMergedExtract(f) {
  const source = path.join(f.home, "source.zip"),
    parent = path.join(f.project, "folder");
  await fs.writeFile(
    source,
    extractionZip([
      { name: "folder/a", bytes: "first" },
      { name: "folder/b", bytes: "second" },
    ]),
  );
  await fs.mkdir(parent);
  const publish = f.publisher.publish.bind(f.publisher);
  let count = 0;
  f.publisher.publish = async (...args) => {
    if (++count === 2) throw fileProblem("FILE_ACCESS_DENIED", 403);
    return publish(...args);
  };
  const job = await f.jobs.start(f.scope, extractOperation(source, f.project));
  await f.until(() => f.jobs.get(f.scope, job.id).conflict);
  await f.jobs.resolve(f.scope, job.id, {
    conflictId: f.jobs.get(f.scope, job.id).conflict.id,
    decision: "merge",
    applyToRemaining: false,
  });
  assert.equal((await retrySettled(f, job)).status, "partially_completed");
  f.publisher.publish = publish;
  return { job, source, parent, target: path.join(parent, "b") };
}
