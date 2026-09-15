import { fileClientIssue } from "./file-api.js";

const invalid = () => fileClientIssue("FILE_INVALID_RESPONSE", 502);
const active = (job) =>
  ["queued", "running", "waiting_for_conflict", "cancelling"].includes(job.status);
export function checkedJob(job, scopeId, id) {
  if (
    !job ||
    typeof job.id !== "string" ||
    job.scopeId !== scopeId ||
    (id && job.id !== id) ||
    typeof job.status !== "string"
  )
    throw invalid();
  return job;
}

/** Upload views borrow the sole FileJobClient queue, snapshot and polling budget. */
export class UploadJobObserver {
  constructor(session) {
    this.session = session;
    this.watched = new Map();
    this.known = new Map();
    this.transient = new Map();
    this.request = (scopeId, suffix, body, envelope = null) =>
      session.enqueue(async (signal, owns) => {
        const result = await session.client.mutate(suffix, { scopeId, body, signal });
        if (!owns()) return;
        if (envelope) {
          const job = checkedJob(envelope === "bare" ? result : result.job, scopeId);
          if (envelope === "child") this.transient.set(job.id, body.groupId);
          session.accept(job, true);
          this.reconcile();
        }
        return result;
      });
    this.inspect = (scopeId, id) =>
      session.enqueue(async (signal, owns) => {
        const job = checkedJob(
          await session.client.get(`/jobs/${encodeURIComponent(id)}`, {}, signal),
          scopeId,
          id,
        );
        if (owns()) session.accept(job, session.tracked.has(id));
        return job;
      });
    this.history = (scopeId, cursor = null) =>
      session.enqueue(async (signal, owns) => {
        const page = await session.client.get("/jobs", { cursor }, signal);
        if (!Array.isArray(page.jobs) || page.jobs.length > 200) throw invalid();
        page.jobs.forEach((job) => checkedJob(job, scopeId));
        if (owns()) session.observeHistory(page, cursor);
        return page;
      });
    this.load = (scopeId, id, maxEntries) =>
      session.enqueue(async (signal, owns) => {
        const job = checkedJob(
          await session.client.get(`/jobs/${encodeURIComponent(id)}`, {}, signal),
          scopeId,
          id,
        );
        if (job.kind !== "upload_group") throw invalid();
        if (!owns()) return;
        session.accept(job, true);
        const cursors = new Set();
        let cursor = null;
        const rows = new Map();
        do {
          const page = await session.readEntries(id, cursor, signal, owns, true);
          if (!owns()) return;
          if (page.entries.length > 200) throw invalid();
          for (const row of page.entries) {
            if (typeof row.id !== "string" || rows.has(row.id)) throw invalid();
            rows.set(row.id, row);
          }
          if (rows.size > maxEntries || (page.nextCursor && cursors.has(page.nextCursor)))
            throw invalid();
          cursor = page.nextCursor;
          cursors.add(cursor);
        } while (cursor);
        this.known.set(id, { scopeId, maxEntries });
        const watch = this.watch(id);
        do {
          await this.read(id, signal, owns);
        } while (owns() && this.watched.get(id) === watch && watch.cursor);
        this.reconcile();
        return [...rows.values()];
      });
    this.select = (id) => {
      if (session.state.uploadGroupId !== id && this.known.has(id)) this.watch(id);
      session.update({ uploadGroupId: id });
      this.reconcile();
    };
  }
  watch(id) {
    const watch = {
      ...this.known.get(id),
      cursor: null,
      seen: new Set(),
      cursors: new Set(),
    };
    this.watched.set(id, watch);
    return watch;
  }
  reconcile() {
    const { state } = this.session;
    const jobs = new Map(state.jobs.map((job) => [job.id, job]));
    const local = new Set(this.transient.values());
    for (const id of this.known.keys()) {
      const terminal = [
        "completed",
        "partially_completed",
        "failed",
        "cancelled",
        "interrupted",
      ].includes(jobs.get(id)?.status);
      if (id !== state.uploadGroupId && terminal && !local.has(id))
        this.watched.delete(id);
      else if (!this.watched.has(id)) this.watch(id);
    }
  }
  async read(id, signal, owns) {
    const watch = this.watched.get(id);
    if (!watch) return;
    const { session } = this;
    if (!watch.cursor) {
      watch.seen = new Set();
      watch.cursors = new Set();
    }
    try {
      const page = await session.client.get(
        `/jobs/${encodeURIComponent(id)}/upload-children`,
        { cursor: watch.cursor },
        signal,
      );
      if (!owns() || this.watched.get(id) !== watch) return;
      if (!Array.isArray(page.children) || page.children.length > 200) throw invalid();
      const rows = new Map(
        (session.state.entries[id]?.entries || []).map((row) => [row.id, row]),
      );
      const mapped = { ...session.state.children?.[id] };
      for (const child of page.children) {
        const row = rows.get(child.entryId);
        if (!row || watch.seen.has(child.entryId)) throw invalid();
        if (child.job !== null) {
          checkedJob(child.job, watch.scopeId);
          if (child.job.kind !== (row.type === "file" ? "upload" : "create_directory"))
            throw invalid();
        }
        mapped[child.entryId] = child.job;
        watch.seen.add(child.entryId);
      }
      if (
        watch.seen.size > watch.maxEntries ||
        (page.nextCursor && watch.cursors.has(page.nextCursor))
      )
        throw invalid();
      watch.cursor = page.nextCursor;
      watch.cursors.add(watch.cursor);
      if (!watch.cursor)
        for (const key of Object.keys(mapped))
          if (!watch.seen.has(key)) delete mapped[key];
      session.update({ children: { ...session.state.children, [id]: mapped } });
    } catch (error) {
      watch.cursor = null;
      throw error;
    }
  }
  settled(job) {
    if (this.transient.has(job.id) && !active(job)) {
      this.transient.delete(job.id);
      this.session.tracked.delete(job.id);
    }
  }
}
