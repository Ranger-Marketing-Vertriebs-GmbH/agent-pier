import { fileClientIssue } from "./file-api.js";
import { collectUploadSelection } from "./file-upload-selection.js";
import {
  planUploadGroup,
  submitUploadGroup,
  uploadRequestId,
  metadataBytes,
} from "./file-upload-group.js";
import { uploadFile } from "./file-upload-transport.js";

const terminal = new Set([
  "completed",
  "partially_completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const closed = (row) =>
  ["completed", "skipped", "published"].includes(row.status) || row.outputPublished;
const safeError = (error) =>
  typeof error?.code === "string" && error.code.startsWith("FILE_")
    ? error
    : fileClientIssue("FILE_IO_ERROR", 500);
const parentReady = (parents, row) => {
  const parts = row.relativePath.split("/");
  return parts.slice(0, -1).every((_, index) => {
    const parent = parents.get(parts.slice(0, index + 1).join("/"));
    return (
      parent?.status === "completed" &&
      parent.path ===
        row.path
          .split("/")
          .slice(0, -(parts.length - index - 1))
          .join("/")
    );
  });
};

/** Owns browser File references/attempts for one client + opened scope, never a folder. */
export class FileUploadClient {
  constructor(client, scopeId, jobs, limits, readOnly) {
    Object.assign(this, { client, scopeId, jobs, limits, readOnly });
    this.groups = [];
    this.listeners = new Set();
    this.state = { groups: [], selected: null, error: null };
    this.getSnapshot = () => this.state;
    this.subscribe = (listener) => {
      this.listeners.add(listener);
      if (this.listeners.size === 1) {
        this.listening = true;
        this.unlisten = jobs.subscribe(() => this.sync());
        this.sync();
      }
      return () => {
        this.listeners.delete(listener);
        if (this.listeners.size) return;
        this.listening = false;
        this.unlisten?.();
        for (const group of this.groups) {
          group.selectionController?.abort();
          for (const attempt of group.attempts.values()) attempt.controller?.abort();
          group.files.clear();
          delete group.selection;
        }
      };
    };
    this.add = async (input, folder) => {
      if (!this.alive || this.readOnly || !this.scopeId) return;
      const group = this.makeGroup(folder);
      this.groups.push(group);
      this.selected = group;
      this.emit();
      const controller = new AbortController();
      group.selectionController = controller;
      try {
        const selection = await collectUploadSelection(input, {
          maxEntries: limits.jobEntries,
          maxDepth: limits.maxDepth,
          signal: controller.signal,
        });
        if (!this.alive || group.cancelRequested) return;
        group.omissions = selection.omissions;
        for (const { file, relativePath } of selection.files)
          group.files.set(relativePath, file);
        group.plan = planUploadGroup(selection, folder, limits);
        group.selection = {
          ...selection,
          files: selection.files.map(({ relativePath, file }) => ({
            relativePath,
            file: { size: file.size },
          })),
        };
        if (!group.plan.batches.length) {
          group.phase = "empty";
          this.emit();
          return;
        }
        await this.submit(group);
      } catch (error) {
        if (this.alive && !group.cancelRequested) {
          group.files.clear();
          delete group.selection;
          group.phase = "failed";
          group.error = safeError(error);
          this.emit();
        }
      } finally {
        group.selectionController = null;
      }
    };
    this.select = (group) => {
      if (!this.alive) return;
      this.selected = group;
      jobs.selectUploadGroup(group.serverId);
      this.emit();
    };
    this.recover = async (job) => {
      if (!this.alive) return;
      let group = this.groups.find((item) => item.serverId === job.id);
      if (!group) {
        group = this.makeGroup("");
        Object.assign(group, {
          serverId: job.id,
          recovered: true,
          autoplay: false,
          phase: "loading",
        });
        this.groups.push(group);
      }
      this.select(group);
      try {
        group.rows = await jobs.loadUploadGroup(scopeId, job.id, limits.jobEntries);
        if (!this.alive) return;
        group.phase = "active";
        this.sync();
      } catch (error) {
        if (this.alive) {
          group.error = safeError(error);
          group.phase = "failed";
          this.emit();
        }
      }
    };
    this.reselect = async (input, group) => {
      if (!this.alive || this.readOnly) return;
      group.selectionController?.abort();
      const controller = new AbortController();
      group.selectionController = controller;
      try {
        const selection = await collectUploadSelection(input, {
          maxEntries: limits.jobEntries,
          maxDepth: limits.maxDepth,
          signal: controller.signal,
        });
        if (!this.alive || controller.signal.aborted) return;
        const rows = new Map(
          group.rows
            .filter((row) => row.type === "file")
            .map((row) => [row.relativePath, row]),
        );
        if (
          selection.files.some(
            ({ file, relativePath }) =>
              !rows.has(relativePath) || rows.get(relativePath).bytes !== file.size,
          )
        )
          throw fileClientIssue("FILE_INVALID_OPERATION", 409);
        group.omissions = selection.omissions;
        for (const { file, relativePath } of selection.files) {
          const row = rows.get(relativePath);
          if (closed(row)) continue;
          group.files.set(relativePath, file);
          this.retry(group, row.id);
        }
        group.error = null;
        this.emit();
      } catch (error) {
        if (this.alive && !controller.signal.aborted) {
          group.error = safeError(error);
          this.emit();
        }
      } finally {
        if (group.selectionController === controller) group.selectionController = null;
      }
    };
    this.retry = (group, id, captured) => {
      if (!this.alive || this.readOnly) return;
      if (!id) {
        if (group.plan) this.submit(group);
        return;
      }
      const row = group.rows.find((item) => item.id === id);
      if (!row || closed(row) || !group.files.has(row.relativePath)) return;
      const prior = group.attempts.get(id);
      const child = jobs.getSnapshot().children?.[group.serverId]?.[id];
      if (captured && (captured.attempt !== prior || captured.childId !== child?.id))
        return;
      if (prior?.refused) {
        this.refreshRefused(group, id, prior);
      } else if (prior && ["reservation_unknown", "blocked"].includes(prior.phase)) {
        prior.phase = "new";
        this.pump();
      } else if (
        prior &&
        ["checking", "sending", "waiting", "reserving", "completed"].includes(prior.phase)
      ) {
        if (prior.uploadId) this.inspect(group, row, prior);
      } else {
        if (child && !terminal.has(child.status)) return;
        const evidence = prior?.uploadId ? this.child(group, row, prior) : child;
        if (
          !evidence &&
          !["failed", "interrupted", "cancelled"].includes(row.status) &&
          !(["ready", "pending"].includes(row.status) && child === undefined)
        )
          return;
        if (
          evidence &&
          (!terminal.has(evidence.status) || evidence.status === "completed")
        )
          return;
        group.cancelRequested = false;
        const attempt = this.attempt();
        group.attempts.set(id, attempt);
        this.pump();
      }
      this.emit();
    };
    this.cancel = async (group, id, captured) => {
      if (this.readOnly || !this.alive) return;
      if (!id) {
        group.cancelRequested = true;
        group.selectionController?.abort();
        if (group.phase === "selecting") group.phase = "cancelled";
        for (const attempt of group.attempts.values()) {
          attempt.cancelRequested = true;
          attempt.controller?.abort();
        }
      }
      const attempt = captured ? captured.attempt : group.attempts.get(id);
      if (attempt) {
        attempt.cancelRequested = true;
        attempt.controller?.abort();
      }
      const child = jobs.getSnapshot().children?.[group.serverId]?.[id];
      const target = id
        ? attempt?.uploadId || (captured ? captured.childId : child?.id)
        : group.serverId;
      if (!target && id) {
        if (
          captured &&
          (captured.attempt !== group.attempts.get(id) || captured.childId !== child?.id)
        )
          return;
        const row = group.rows.find((item) => item.id === id);
        if (row && group.files.has(row.relativePath) && !closed(row)) {
          const pending = attempt || this.attempt();
          pending.cancelRequested = true;
          group.attempts.set(id, pending);
          if (!pending.body) this.reserve(group, row, pending);
        }
      }
      this.emit();
      if (target) {
        try {
          await jobs.cancel(scopeId, target);
        } catch (error) {
          if (this.alive) group.error = safeError(error);
        }
        if (this.alive) this.sync();
      }
    };
  }
  get alive() {
    return this.listening && (this.isCurrent?.() ?? true);
  }
  makeGroup(folder) {
    return {
      id: crypto.randomUUID(),
      folder,
      serverId: null,
      files: new Map(),
      attempts: new Map(),
      rows: [],
      omissions: [],
      phase: "selecting",
      autoplay: true,
      error: null,
      cancelRequested: false,
    };
  }
  attempt() {
    return {
      phase: "new",
      body: null,
      uploadId: null,
      loaded: 0,
      cancelRequested: false,
    };
  }
  emit() {
    if (!this.alive) return;
    this.state = {
      groups: [...this.groups],
      selected: this.selected || null,
      error: null,
    };
    for (const listener of this.listeners) listener();
  }
  async submit(group) {
    if (group.submitting || !this.alive) return;
    group.submitting = true;
    group.phase = "planning";
    group.error = null;
    this.emit();
    try {
      const result = await submitUploadGroup(this.jobs, group.selection, {
        scopeId: this.scopeId,
        plan: group.plan,
        maxEntries: this.limits.jobEntries,
        owns: () => this.alive,
        cancelled: () => group.cancelRequested,
        onGroup: (id) => {
          group.serverId = id;
          if (this.selected === group) this.jobs.selectUploadGroup(id);
        },
      });
      if (!this.alive) return;
      group.rows = result.entries;
      group.phase = "active";
      this.sync();
    } catch (error) {
      if (this.alive) {
        group.phase =
          error.name === "AbortError" && group.cancelRequested
            ? "cancelled"
            : "metadata_unknown";
        group.error = group.phase === "cancelled" ? null : safeError(error);
      }
    } finally {
      group.submitting = false;
      this.emit();
    }
  }
  child(group, row, attempt, knownJobs) {
    const state = this.jobs.getSnapshot();
    const mapped = state.children?.[group.serverId]?.[row.id];
    return (
      (knownJobs
        ? knownJobs.get(attempt.uploadId)
        : state.jobs.find((job) => job.id === attempt.uploadId)) ||
      (mapped?.id === attempt.uploadId ? mapped : null) ||
      attempt.job
    );
  }
  sync() {
    if (!this.alive) return;
    const state = this.jobs.getSnapshot();
    const knownJobs = new Map(state.jobs.map((job) => [job.id, job]));
    for (const group of this.groups) {
      if (group.phase !== "active") continue;
      group.rows = state.entries[group.serverId]?.entries || group.rows;
      group.job = knownJobs.get(group.serverId) || group.job;
      for (const row of group.rows) {
        const attempt = group.attempts.get(row.id);
        if (["completed", "skipped"].includes(row.status))
          group.files.delete(row.relativePath);
        if (!attempt?.uploadId) continue;
        const job = this.child(group, row, attempt, knownJobs);
        if (
          job &&
          terminal.has(job.status) &&
          !["sending", "reserving"].includes(attempt.phase)
        ) {
          attempt.phase = job.status;
          attempt.error = job.issue
            ? fileClientIssue(job.issue.code, 409, job.issue.args)
            : null;
        }
      }
    }
    this.emit();
    this.pump();
  }
  pump() {
    if (!this.alive || this.pumping || this.readOnly) return;
    this.pumping = true;
    try {
      let occupied = this.groups.reduce(
        (count, group) =>
          count +
          [...group.attempts.values()].filter((attempt) =>
            ["reserving", "waiting", "sending"].includes(attempt.phase),
          ).length,
        0,
      );
      for (const group of this.groups) {
        if (group.phase !== "active" || group.cancelRequested) continue;
        const parents = new Map(
          group.rows
            .filter((row) => row.type === "directory")
            .map((row) => [row.relativePath, row]),
        );
        for (const row of group.rows) {
          if (row.type !== "file" || closed(row) || !group.files.has(row.relativePath))
            continue;
          let attempt = group.attempts.get(row.id);
          if (!attempt && group.autoplay && ["ready", "pending"].includes(row.status)) {
            attempt = this.attempt();
            group.attempts.set(row.id, attempt);
          }
          if (attempt?.phase === "new" && occupied < 3) {
            occupied++;
            this.reserve(group, row, attempt);
          }
          if (
            attempt?.phase === "waiting" &&
            !attempt.cancelRequested &&
            parentReady(parents, row)
          )
            this.send(group, row, attempt);
        }
      }
    } finally {
      this.pumping = false;
    }
  }
  async reserve(group, row, attempt) {
    if (!this.alive || attempt.phase === "reserving") return;
    if (!attempt.body) {
      const slash = row.path.lastIndexOf("/");
      attempt.body = Object.freeze({
        requestId: uploadRequestId(),
        path: slash < 0 ? "" : row.path.slice(0, slash) || "/",
        name: row.path.slice(slash + 1),
        bytes: row.bytes,
        groupId: group.serverId,
        entryId: row.id,
      });
    }
    if (metadataBytes(attempt.body) >= 60 * 1024) {
      attempt.phase = "failed";
      attempt.error = fileClientIssue("FILE_LIMIT_EXCEEDED", 413);
      this.emit();
      return;
    }
    attempt.phase = "reserving";
    attempt.error = null;
    this.emit();
    try {
      const result = await this.jobs.uploadRequest(
        this.scopeId,
        "/uploads",
        attempt.body,
        "child",
      );
      if (!this.alive) return;
      if (result.uploadId !== result.job.id)
        throw fileClientIssue("FILE_INVALID_RESPONSE", 502);
      attempt.uploadId = result.uploadId;
      attempt.job = result.job;
      attempt.phase = "waiting";
      if (attempt.cancelRequested || group.cancelRequested) {
        attempt.phase = "checking";
        await this.jobs.cancel(this.scopeId, result.uploadId);
      }
      this.sync();
    } catch (error) {
      if (this.alive) {
        // Group claim rejects this exact response before allocating a child job.
        attempt.refused =
          error.code === "FILE_INVALID_OPERATION" &&
          error.status === 409 &&
          !attempt.uploadId;
        attempt.phase = attempt.refused
          ? "failed"
          : error.code === "FILE_UPLOAD_PENDING"
            ? "blocked"
            : "reservation_unknown";
        attempt.error = safeError(error);
        this.emit();
      }
    }
  }
  async refreshRefused(group, id, prior) {
    if (prior.refreshing) return;
    group.cancelRequested = false;
    prior.cancelRequested = false;
    prior.refreshing = true;
    prior.phase = "checking";
    const owns = () => this.alive && group.attempts.get(id) === prior;
    try {
      const rows = await this.jobs.loadUploadGroup(
        this.scopeId,
        group.serverId,
        this.limits.jobEntries,
      );
      if (!owns() || group.cancelRequested || prior.cancelRequested) return;
      group.rows = rows;
      prior.refused = false;
      prior.phase = "failed";
      this.retry(group, id);
    } catch (error) {
      if (owns()) prior.error = safeError(error);
    } finally {
      if (owns()) {
        prior.refreshing = false;
        if (prior.refused) prior.phase = "failed";
        this.emit();
      }
    }
  }
  async send(group, row, attempt) {
    if (!this.alive || attempt.phase !== "waiting") return;
    attempt.phase = "sending";
    attempt.controller = new AbortController();
    const owns = () => this.alive && group.attempts.get(row.id) === attempt;
    this.emit();
    try {
      attempt.job = await uploadFile(
        this.client,
        attempt.uploadId,
        group.files.get(row.relativePath),
        {
          scopeId: this.scopeId,
          signal: attempt.controller.signal,
          owns,
          onProgress: (loaded, total) => {
            if (owns()) this.updateProgress(group, row.id, loaded, total);
          },
        },
      );
    } catch (error) {
      if (owns()) attempt.transportError = safeError(error);
    } finally {
      if (owns()) {
        attempt.controller = null;
        attempt.phase = "checking";
        this.emit();
        await this.inspect(group, row, attempt);
        this.pump();
      }
    }
  }
  updateProgress(group, id, loaded, total) {
    const attempt = group.attempts.get(id);
    if (!attempt) return;
    attempt.loaded = loaded;
    attempt.total = total;
    this.emit();
  }
  async inspect(group, row, attempt) {
    try {
      const job = await this.jobs.inspect(this.scopeId, attempt.uploadId);
      if (!this.alive || group.attempts.get(row.id) !== attempt) return;
      attempt.job = job;
      attempt.error = null;
      this.sync();
    } catch (error) {
      if (this.alive) {
        attempt.error = safeError(error);
        this.emit();
      }
    }
  }
}
