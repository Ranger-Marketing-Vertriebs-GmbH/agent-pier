import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveFile, entryRevision } from "./file-paths.js";
import { inodeIdentity } from "./file-stage.js";
import { fileProblem } from "./file-errors.js";
import { safeIssue } from "./file-job-handlers.js";
import { terminalStates } from "./file-schema.js";

export class UploadGroups {
  constructor(owner) {
    this.owner = owner;
    this.dirty = new Set();
  }
  async wake(scope, id) {
    const { jobs, store, journal, barrier } = this.owner;
    if (jobs.closed || this.owner.closed) return;
    await barrier.run(() => {
      const group = journal.group(id);
      if (!group?.committed || group.cancelled || group.invalid) return;
      if (jobs.owns(id)) {
        this.dirty.add(id);
        return;
      }
      const job = jobs.get(scope, id);
      if (job.status === "completed") return;
      store.transition(id, job.status, "queued");
      jobs.reservations.delete(id);
      jobs.enqueue({
        scope,
        job: jobs.get(scope, id),
        operation: store.getOperation(id),
        policy: { transfer: false, readOnly: false, aggregate: true },
        handler: (context) => this.run(context),
      });
    });
  }
  async directory(context, row, target) {
    const { store, jobs, publisher, barrier, journal } = this.owner;
    const { scope, jobId, signal } = context;
    signal.throwIfAborted();
    const selected = await resolveFile(scope, target, {
      followLeaf: false,
      allowMissingLeaf: true,
    });
    if (selected.stat?.isDirectory()) {
      const identity = inodeIdentity(selected.stat);
      if (journal.directoryAlias(jobId, row.id, identity))
        throw fileProblem("FILE_UPLOAD_ALIAS", 409);
      await publisher.assertExpected(
        scope,
        target,
        entryRevision(selected.stat, selected.linkIdentity),
        { expectedTarget: selected.absolute },
      );
      return {
        path: selected.path,
        absolute: selected.absolute,
        revision: entryRevision(selected.stat, selected.linkIdentity),
        identity,
      };
    }
    const child = await jobs.start(scope, {
      requestId: `${Date.now()}:${randomUUID()}`,
      kind: "create_directory",
      sources: [],
      target: path.dirname(target),
      name: path.basename(target),
      options: {},
      parentJobId: jobId,
      entryId: row.id,
    });
    await barrier.run(() =>
      store.putEntry(jobId, {
        ...store.getEntry(jobId, row.id),
        currentJobId: child.id,
        status: "running",
      }),
    );
    const result = await jobs.join(scope, child.id);
    const rows = journal.rows(child.id);
    if (result.status !== "completed")
      throw fileProblem(result.issue?.code || "FILE_CANCELLED", 409);
    const output = rows.find((item) => item.status === "completed");
    if (!output) return null;
    const actual = await publisher.assertExpected(scope, output.path, output.revision);
    if (journal.directoryAlias(jobId, row.id, inodeIdentity(actual.stat)))
      throw fileProblem("FILE_UPLOAD_ALIAS", 409);
    return {
      path: output.path,
      absolute: actual.absolute,
      revision: output.revision,
      identity: inodeIdentity(actual.stat),
    };
  }
  async run(context) {
    const { store, journal, barrier, jobs } = this.owner;
    const { scope, jobId, signal } = context;
    for (const row of journal
      .rows(jobId)
      .filter((item) => item.type === "directory")
      .sort(
        (a, b) => a.relativePath.split("/").length - b.relativePath.split("/").length,
      )) {
      if (row.status !== "pending") continue;
      if (journal.group(jobId).cancelled) break;
      signal.throwIfAborted();
      const parentPath = path.dirname(row.relativePath);
      const parent = parentPath === "." ? null : journal.rowByPath(jobId, parentPath);
      if (parent && parent.status !== "completed") continue;
      const target = path.join(
        parent?.path || journal.group(jobId).destinationPath,
        path.basename(row.relativePath),
      );
      try {
        await this.readyParent(scope, jobId, row);
        const output = await this.directory(context, row, target);
        await barrier.run(() => {
          store.putEntry(jobId, {
            ...store.getEntry(jobId, row.id),
            ...output,
            status: output ? "completed" : "skipped",
          });
          journal.touch(jobId);
        });
      } catch (error) {
        await barrier.run(() => {
          store.putEntry(jobId, {
            ...store.getEntry(jobId, row.id),
            status: signal.aborted ? "cancelled" : "failed",
            issue: safeIssue(error),
          });
          journal.touch(jobId);
        });
      }
    }
    await barrier.run(() => {
      const rows = journal.rows(jobId),
        byPath = new Map(rows.map((row) => [row.relativePath, row]));
      for (const row of rows) {
        if (
          ["completed", "skipped", "published"].includes(row.status) ||
          (row.currentJobId && jobs.owns(row.currentJobId))
        )
          continue;
        const parent = byPath.get(path.dirname(row.relativePath));
        if (parent && parent.status !== "completed") {
          const state =
            parent.status === "skipped"
              ? "skipped"
              : ["failed", "cancelled", "interrupted"].includes(parent.status)
                ? parent.status
                : "pending";
          const issue =
            state === "failed" ? { code: "FILE_UPLOAD_PARENT", args: {} } : null;
          store.putEntry(jobId, { ...row, status: state, issue });
          Object.assign(row, { status: state, issue });
          if (
            row.currentJobId &&
            ["skipped", "failed", "cancelled", "interrupted"].includes(state)
          ) {
            jobs.reservations.delete(row.currentJobId);
            journal.settle(scope, row.currentJobId, state, issue);
          }
        } else if (
          row.type === "file" &&
          ["pending", "ready", "queued"].includes(row.status)
        ) {
          const target = path.join(
            parent?.path || journal.group(jobId).destinationPath,
            path.basename(row.relativePath),
          );
          store.putEntry(jobId, {
            ...row,
            path: target,
            status: row.currentJobId ? "queued" : "ready",
          });
          if (row.currentJobId) journal.updateRow(row.currentJobId, { path: target });
        }
      }
      this.aggregate(scope, jobId);
    });
    return { aggregatedGeneration: journal.group(jobId).aggregatedGeneration };
  }
  aggregate(scope, id, group = this.owner.journal.group(id)) {
    const { journal, store, jobs } = this.owner;
    const rows = journal.rows(id),
      job = jobs.get(scope, id);
    const live = rows.some((row) => row.currentJobId && jobs.owns(row.currentJobId));
    const pending = rows.some((row) =>
      ["pending", "ready", "queued"].includes(row.status),
    );
    const complete = rows.every((row) => ["completed", "skipped"].includes(row.status));
    const status = group.cancelled
      ? live
        ? "cancelling"
        : "cancelled"
      : live
        ? "running"
        : pending
          ? "queued"
          : complete
            ? "completed"
            : rows.some((row) => row.status === "completed")
              ? "partially_completed"
              : "failed";
    journal.refresh(id);
    store.transition(id, job.status, status);
    group.aggregatedGeneration = group.generation;
    journal.save("upload_groups", id, group);
  }
  async readyParent(scope, id, row) {
    const { journal } = this.owner;
    const parent = journal.rowByPath(id, path.dirname(row.relativePath)),
      group = journal.group(id);
    if (parent && parent.status !== "completed")
      throw fileProblem("FILE_UPLOAD_PARENT", 409);
    const root = await resolveFile(scope, this.owner.store.getOperation(id).target);
    if (
      !root.stat.isDirectory() ||
      inodeIdentity(root.stat) !== group.rootIdentity ||
      root.absolute !== group.rootAbsolute
    )
      throw fileProblem("FILE_PATH_CHANGED", 409);
    const selected = parent ? await resolveFile(scope, parent.path) : root;
    if (
      !selected.stat.isDirectory() ||
      inodeIdentity(selected.stat) !== (parent?.identity || group.rootIdentity) ||
      selected.absolute !== (parent?.absolute || group.rootAbsolute)
    )
      throw fileProblem("FILE_PATH_CHANGED", 409);
    return selected;
  }
  async settled(item) {
    const { jobs, store, journal, barrier } = this.owner;
    if (item.ephemeral || jobs.closed || this.owner.closed) return;
    const parent = item.operation.parentJobId;
    if (item.operation.kind === "upload_group") {
      const group = journal.group(item.id),
        dirty = this.dirty.delete(item.id);
      if (item.result && (dirty || item.result.aggregatedGeneration !== group.generation))
        await this.wake(item.scope, item.id);
      return;
    }
    if (item.operation.kind === "upload") {
      await barrier.run(() => {
        const upload = journal.attempt(item.id),
          job = jobs.get(item.scope, item.id);
        upload.lastActivity = store.now();
        journal.save("uploads", item.id, upload);
        if (
          !upload.completed &&
          !upload.published &&
          store.getEntry(item.id, "upload")?.status !== "skipped"
        )
          journal.updateRow(item.id, { status: job.status, issue: job.issue });
        if (parent) {
          journal.touch(parent);
          journal.refresh(parent);
        }
      });
    }
    if (parent) await this.wake(item.scope, parent);
  }
  async cancel(scope, id) {
    const { jobs, store, journal, barrier } = this.owner;
    const children = await barrier.run(() => {
      const group = journal.group(id),
        job = jobs.get(scope, id);
      if (!group) throw fileProblem("FILE_NOT_FOUND", 404);
      if (terminalStates.includes(job.status)) return [];
      group.cancelled = true;
      group.generation++;
      journal.save("upload_groups", id, group);
      store.transition(id, job.status, "cancelling");
      for (const row of journal.rows(id))
        if (
          !["completed", "skipped", "published"].includes(row.status) &&
          !row.currentJobId
        )
          store.putEntry(id, { ...row, status: "cancelled" });
      return journal
        .rows(id)
        .flatMap((row) => (row.currentJobId ? [row.currentJobId] : []));
    });
    jobs.active.get(id)?.controller.abort();
    for (const child of children) await jobs.cancel(scope, child);
    await Promise.all(children.map((child) => jobs.join(scope, child)));
    await barrier.run(() => this.aggregate(scope, id));
    return jobs.get(scope, id);
  }
}
