import { fileErrorMessage } from "../../lib/i18n/messages/files.js";
import { browserUuid } from "../../lib/browser-uuid.js";
import { UploadJobObserver } from "./file-upload-observer.js";
import { FileJobObserver } from "./file-job-observer.js";
import { uploadOwnedJob, activeFileJob } from "./file-job-ownership.js";

function issue(code) {
  const error = new Error();
  error.code = code;
  Object.defineProperty(error, "message", { get: () => fileErrorMessage(code, 409) });
  return error;
}
const environment = {
  hidden: () => document.hidden,
  listen: (callback) => {
    document.addEventListener("visibilitychange", callback);
    return () => document.removeEventListener("visibilitychange", callback);
  },
  timer: (callback, delay) => setTimeout(callback, delay),
  clear: (id) => clearTimeout(id),
};

/** One client owns this snapshot, request queue, abort generation and polling timer. */
export class FileJobClient {
  constructor(client, timing = environment) {
    this.client = client;
    this.timing = timing;
    this.state = {
      jobs: [],
      entries: {},
      children: {},
      history: null,
      uncertain: [],
      error: null,
    };
    this.listeners = new Set();
    this.tracked = new Map();
    this.sweeps = new Map();
    this.resultTurn = 0;
    this.tail = Promise.resolve();
    this.generation = 0;
    this.controllers = new Set();
    this.uploads = new UploadJobObserver(this);
    this.operations = new FileJobObserver(this);
    this.subscribe = this.subscribe.bind(this);
    this.getSnapshot = () => this.state;
    this.start = (scopeId, operation) =>
      this.action(
        "/operations",
        scopeId,
        {
          requestId: `${Date.now()}:${browserUuid()}`,
          ...operation,
        },
        true,
      );
    this.cancel = (scopeId, id) =>
      this.action(`/jobs/${encodeURIComponent(id)}/cancel`, scopeId, {});
    this.resolve = (scopeId, id, decision) =>
      this.action(`/jobs/${encodeURIComponent(id)}/resolve`, scopeId, decision);
    this.refresh = (options = {}) =>
      this.enqueue(async (signal, owns) => {
        if (options.jobId) {
          return this.readEntries(
            options.jobId,
            options.cursor,
            signal,
            owns,
            options.first === true,
          );
        }
        const history = await this.client.get("/jobs", {}, signal);
        if (!owns()) return;
        if (!Array.isArray(history.jobs) || history.jobs.length > 200)
          throw issue("FILE_INVALID_RESPONSE");
        for (const job of history.jobs) {
          this.invalidateManifest(job);
          if (
            !uploadOwnedJob(job) &&
            !["search", "size"].includes(job.kind) &&
            activeFileJob(job)
          )
            this.tracked.set(job.id, job);
        }
        this.update({
          history: this.overlayHistory(history.jobs),
          ...(!this.state.history?.cursor
            ? { history: { ...history, cursor: null } }
            : {}),
          jobs: this.boundedJobs([
            ...this.state.jobs,
            ...history.jobs,
            ...this.tracked.values(),
          ]),
        });
        for (const id of this.tracked.keys()) {
          let job;
          try {
            job = await this.client.get(`/jobs/${encodeURIComponent(id)}`, {}, signal);
          } catch (error) {
            if (!owns()) return;
            if (error.code !== "FILE_NOT_FOUND") throw error;
            this.expired(id);
            continue;
          }
          if (!owns()) return;
          this.accept(job, true);
          this.uploads.settled(job);
          if (job.kind === "search") await this.readEntries(id, undefined, signal, owns);
        }
        this.uploads.reconcile();
        const mutations = [...this.tracked.values()].filter(
          (job) => !["search", "size"].includes(job.kind),
        );
        const tasks = [
          ...mutations.map((job) => ({ job })),
          ...Array.from(this.uploads.watched.keys(), (id) => ({ childId: id })),
        ];
        // Four pages per poll, fairly shared, using the existing serial queue/timer.
        // Every sweep starts at page one because stable transfer rows change in place.
        for (let count = 0; count < 4 && tasks.length; count++) {
          const task = tasks[this.resultTurn++ % tasks.length];
          if (task.childId) {
            await this.uploads.read(task.childId, signal, owns);
            if (!owns()) return;
            if (!this.uploads.watched.get(task.childId)?.cursor)
              tasks.splice(tasks.indexOf(task), 1);
            continue;
          }
          const { job } = task;
          let sweep = this.sweeps.get(job.id);
          if (!sweep || sweep.status !== job.status) {
            sweep = { cursor: null, status: job.status };
            this.sweeps.set(job.id, sweep);
          }
          let page;
          try {
            page = await this.readEntries(job.id, sweep.cursor, signal, owns, true);
          } catch (error) {
            if (!owns()) return;
            if (error.code !== "FILE_NOT_FOUND") throw error;
            this.expired(job.id);
            tasks.splice(tasks.indexOf(task), 1);
            continue;
          }
          if (!owns()) return;
          sweep.cursor = page.nextCursor;
          if (!page.nextCursor) {
            tasks.splice(tasks.indexOf(task), 1);
            const terminal = ![
              "queued",
              "running",
              "waiting_for_conflict",
              "cancelling",
            ].includes(job.status);
            const rows = this.state.entries[job.id].entries;
            // A terminal envelope alone cannot settle publication/removal uncertainty.
            const retire =
              terminal &&
              !uploadOwnedJob(job) &&
              job.id !== this.inspectedId &&
              !job.conflict &&
              job.status !== "interrupted" &&
              ![
                "FILE_INTERRUPTED",
                "FILE_RENAME_RECOVERY",
                "FILE_ARCHIVE_PENDING",
              ].includes(job.issue?.code) &&
              rows.every(
                (row) =>
                  ["completed", "failed", "skipped", "cancelled"].includes(row.status) &&
                  row.sourceRemovalPending !== true,
              );
            if (retire) {
              this.tracked.delete(job.id);
              this.sweeps.delete(job.id);
            }
            this.update({
              jobs: this.boundedJobs(this.state.jobs, retire ? job.id : null),
              entries: {
                ...this.state.entries,
                [job.id]: {
                  ...this.state.entries[job.id],
                  complete: terminal,
                  version: (this.state.entries[job.id].version || 0) + 1,
                },
              },
            });
          }
        }
      });
  }
  // Retained result pages serve Cut/purge and inspection independently of polling.
  // Keep bounded recent metadata plus active/unresolved/explicitly selected watches.
  boundedJobs(values, completedId) {
    const ordered = completedId
      ? [
          ...values.filter((job) => job.id !== completedId),
          ...values.filter((job) => job.id === completedId),
        ]
      : values;
    const jobs = [...new Map(ordered.map((job) => [job.id, job])).values()];
    const observed = (job) =>
      job.id === completedId || this.state.entries[job.id]?.complete;
    const inactive = jobs.filter((job) => !this.tracked.has(job.id));
    // A newly visited history page must not evict the metadata paired with a
    // captured final outcome before Cut/purge consumers can use that evidence.
    const recent = new Set(
      [...inactive.filter((job) => !observed(job)), ...inactive.filter(observed)]
        .slice(-200)
        .map((job) => job.id),
    );
    return jobs.filter((job) => this.tracked.has(job.id) || recent.has(job.id));
  }
  expired(id) {
    this.tracked.delete(id);
    this.sweeps.delete(id);
    this.update({
      jobs: this.state.jobs.filter((job) => job.id !== id),
      history: this.state.history && {
        ...this.state.history,
        jobs: this.state.history.jobs.filter((job) => job.id !== id),
      },
    });
  }
  update(patch) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  subscribe(listener) {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.generation++;
      this.unlisten = this.timing.listen(() => this.schedule());
      this.poll();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      this.generation++;
      this.timing.clear(this.timer);
      this.unlisten?.();
      for (const controller of this.controllers) controller.abort();
    };
  }
  schedule() {
    this.timing.clear(this.timer);
    if (!this.listeners.size) return;
    this.timer = this.timing.timer(
      () => this.poll(),
      this.timing.hidden() ? 10000 : 1500,
    );
  }
  poll() {
    this.timing.clear(this.timer);
    if (this.polling || !this.listeners.size) return;
    this.polling = true;
    this.refresh()
      .catch(() => {})
      .finally(() => {
        this.polling = false;
        this.schedule();
      });
  }
  enqueue(work) {
    const generation = this.generation;
    const controller = new AbortController();
    this.controllers.add(controller);
    const owns = () =>
      generation === this.generation &&
      !controller.signal.aborted &&
      this.listeners.size > 0;
    const result = this.tail
      .then(async () => {
        if (!owns()) throw new DOMException("Aborted", "AbortError");
        try {
          const value = await work(controller.signal, owns);
          if (!owns()) throw new DOMException("Aborted", "AbortError");
          this.update({ error: null });
          return value;
        } catch (error) {
          if (owns()) this.update({ error });
          throw error;
        }
      })
      .finally(() => this.controllers.delete(controller));
    this.tail = result.catch(() => {});
    return result;
  }
  accept(job, track = false) {
    this.invalidateManifest(job);
    if (track || this.tracked.has(job.id)) this.tracked.set(job.id, job);
    this.update({
      history: this.overlayHistory([job]),
      jobs: this.boundedJobs([...this.state.jobs, job]),
    });
  }
  overlayHistory(jobs) {
    if (!this.state.history) return null;
    const fresh = new Map(jobs.map((job) => [job.id, job]));
    return {
      ...this.state.history,
      jobs: this.state.history.jobs.map((job) => fresh.get(job.id) || job),
    };
  }
  observeHistory(page, cursor) {
    for (const job of page.jobs) {
      this.invalidateManifest(job);
      if (!uploadOwnedJob(job) && activeFileJob(job)) this.tracked.set(job.id, job);
    }
    this.update({
      history: { ...page, cursor },
      jobs: this.boundedJobs([...this.state.jobs, ...page.jobs]),
    });
  }
  invalidateManifest(job) {
    const version = job.manifestVersion || job.conflict?.manifestVersion;
    const prior = this.state.entries[job.id]?.manifestVersion;
    if (job.kind !== "archive" || !version || !prior || version === prior) return;
    this.sweeps.delete(job.id);
    this.update({
      entries: {
        ...this.state.entries,
        [job.id]: {
          entries: [],
          manifestVersion: version,
          nextCursor: null,
          complete: false,
        },
      },
    });
  }
  action(suffix, scopeId, body, track = false) {
    return this.enqueue(async (signal, owns) => {
      const preserve =
        suffix === "/operations" && ["archive", "extract"].includes(body.kind);
      const forget = () =>
        this.update({
          uncertain: this.state.uncertain.filter(
            (item) => item.body.requestId !== body.requestId,
          ),
        });
      let job;
      try {
        job = await this.client.mutate(suffix, { scopeId, body, signal });
      } catch (error) {
        if (owns() && preserve) {
          if (!error.status || error.status >= 500)
            this.update({
              uncertain: [
                ...this.state.uncertain.filter(
                  (item) => item.body.requestId !== body.requestId,
                ),
                { scopeId, body: structuredClone(body) },
              ],
            });
          else forget();
        }
        throw error;
      }
      if (!owns()) return;
      if (job.scopeId !== scopeId) throw issue("FILE_INVALID_SCOPE");
      if (preserve) forget();
      this.accept(job, track);
      return job;
    });
  }
  async readEntries(id, cursor, signal, owns, sweep = false) {
    const prior = this.state.entries[id];
    if (!sweep) cursor ??= prior?.tailCursor;
    const page = await this.client
      .get(`/jobs/${encodeURIComponent(id)}/entries`, { cursor }, signal)
      .catch((error) => {
        if (
          error.code === "FILE_INVALID_CURSOR" &&
          this.state.jobs.some((job) => job.id === id && job.kind === "archive")
        )
          this.sweeps.delete(id);
        throw error;
      });
    if (!owns()) return;
    if (!Array.isArray(page.entries) || page.entries.length > 200)
      throw issue("FILE_INVALID_RESPONSE");
    const manifestVersion = page.entries[0]?.manifestVersion;
    if (page.entries.some((row) => row.manifestVersion !== manifestVersion))
      throw issue("FILE_INVALID_RESPONSE");
    if (
      manifestVersion &&
      prior?.manifestVersion &&
      manifestVersion !== prior.manifestVersion &&
      cursor
    )
      throw issue("FILE_CONFLICT_CHANGED");
    const previousEntries =
      manifestVersion && manifestVersion !== prior?.manifestVersion
        ? []
        : prior?.entries || [];
    const entries = [
      ...new Map(
        [...previousEntries, ...page.entries].map((entry) => [entry.id, entry]),
      ).values(),
    ];
    this.update({
      entries: {
        ...this.state.entries,
        [id]: {
          ...prior,
          manifestVersion,
          entries,
          nextCursor: page.nextCursor,
          tailCursor: cursor ?? null,
          paged: Boolean(cursor || prior?.paged),
        },
      },
    });
    return page;
  }
}
