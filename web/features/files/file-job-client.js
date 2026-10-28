import { fileErrorMessage } from "../../lib/i18n/messages/files.js";
import { browserUuid } from "../../lib/browser-uuid.js";
import { UploadJobObserver } from "./file-upload-observer.js";
import { FileJobObserver } from "./file-job-observer.js";
import { uploadOwnedJob, activeFileJob } from "./file-job-ownership.js";
import { liveClient } from "../../lib/live/live-client.js";

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
    window.addEventListener("focus", callback);
    return () => {
      document.removeEventListener("visibilitychange", callback);
      window.removeEventListener("focus", callback);
    };
  },
  timer: (callback, delay) => setTimeout(callback, delay),
  clear: (id) => clearTimeout(id),
};
// The tab's live channel, made on first use.
const browserLive = {
  subscribe: (topic, listener) => liveClient().subscribe(topic, listener),
  status: () => liveClient().status(),
};
const finite = (value) => Number.isFinite(value);

/**
 * One client owns this snapshot, request queue, abort generation and polling timer.
 * The job envelopes come from the live topic `client.jobsTopic` (files.jobs) when
 * `live` delivers it: then a pushed envelope needs no read of /jobs or /jobs/<id>, and
 * a job's result pages are read again only when its version (`updatedAt`) changes.
 * Without the channel, or for a job the pushed page does not carry, it polls.
 */
export class FileJobClient {
  constructor(
    client,
    timing = environment,
    live = timing === environment && browserLive,
  ) {
    this.client = client;
    this.timing = timing;
    this.live = client.jobsTopic && live ? live : null;
    // The last pushed first page of /jobs, and the last search version read.
    this.feed = null;
    this.searched = new Map();
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
        const pushed = this.pushed() ? this.feed : null;
        const history = pushed || (await this.client.get("/jobs", {}, signal));
        if (!owns()) return;
        this.observePage(history);
        const carried = new Map(pushed?.jobs.map((job) => [job.id, job]));
        for (const id of this.tracked.keys()) {
          let job = carried.get(id);
          try {
            job ??= await this.client.get(`/jobs/${encodeURIComponent(id)}`, {}, signal);
          } catch (error) {
            if (!owns()) return;
            if (error.code !== "FILE_NOT_FOUND") throw error;
            this.expired(id);
            continue;
          }
          if (!owns()) return;
          this.accept(job, true);
          this.uploads.settled(job);
          // A pushed search's rows are read again only for a new version.
          if (job.kind !== "search") continue;
          if (pushed && finite(job.updatedAt) && this.searched.get(id) === job.updatedAt)
            continue;
          await this.readEntries(id, undefined, signal, owns);
          this.searched.set(id, job.updatedAt);
        }
        this.uploads.reconcile();
        // A pushed job's pages are swept again only for a new version.
        const mutations = [...this.tracked.values()].filter(
          (job) =>
            !["search", "size"].includes(job.kind) && (!pushed || this.unswept(job)),
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
            sweep.version = job.updatedAt;
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
  // A first page of /jobs, read or pushed: its active jobs are tracked.
  observePage(history) {
    if (!Array.isArray(history?.jobs) || history.jobs.length > 200)
      throw issue("FILE_INVALID_RESPONSE");
    const jobs = history.jobs.map((job) => this.latest(job));
    for (const job of jobs) {
      this.invalidateManifest(job);
      if (
        !uploadOwnedJob(job) &&
        !["search", "size"].includes(job.kind) &&
        activeFileJob(job)
      )
        this.tracked.set(job.id, job);
    }
    this.update({
      history: this.overlayHistory(jobs),
      ...(!this.state.history?.cursor
        ? { history: { ...history, jobs, cursor: null } }
        : {}),
      jobs: this.boundedJobs([...this.state.jobs, ...jobs, ...this.tracked.values()]),
    });
  }
  // The newer of `job` and the envelope held for it: an answer that left the server
  // before a pushed write never brings the older state back.
  latest(job) {
    const held =
      this.tracked.get(job.id) || this.state.jobs.find((item) => item.id === job.id);
    return finite(held?.updatedAt) &&
      finite(job.updatedAt) &&
      held.updatedAt > job.updatedAt
      ? held
      : job;
  }
  // A job whose result pages were not yet read whole at its version.
  unswept(job) {
    const sweep = this.sweeps.get(job.id);
    return (
      !finite(job.updatedAt) ||
      !sweep ||
      sweep.status !== job.status ||
      Boolean(sweep.cursor) ||
      sweep.version !== job.updatedAt
    );
  }
  // The pushed page stands in for GET /jobs while the channel delivers it.
  pushed() {
    if (!this.live || this.refused || !this.feed) return false;
    const { connected, fallback } = this.live.status();
    return connected && !fallback;
  }
  // The push alone follows every tracked job: the pushed page carries each one with
  // its version, and no result or upload page is part-read.
  followed() {
    const carried = new Map(this.feed.jobs.map((job) => [job.id, job]));
    for (const id of this.tracked.keys())
      if (!finite(carried.get(id)?.updatedAt) || this.sweeps.get(id)?.cursor)
        return false;
    return [...this.uploads.watched.values()].every((watch) => !watch.cursor);
  }
  // A frame of the files.jobs topic (web/lib/live/live-client.js events).
  received(event) {
    if (!this.listeners.size) return;
    if (event.type === "data") {
      this.feed = event.data;
      this.refused = false;
    } else if (event.type === "status") {
      // A channel lost before its first page: the list is read over REST instead.
      if (event.connected || this.state.history || this.timing.hidden())
        return this.schedule();
    } else if (event.type === "stale") this.feed = null;
    else if (event.type === "revoked" || (event.type === "error" && event.code)) {
      this.refused = true;
      this.feed = null;
    } else if (event.type !== "error" || this.feed) return;
    if (!this.timing.hidden()) return this.polling ? (this.again = true) : this.poll();
    // A hidden tab shows the pushed envelopes and reads their pages once shown.
    this.deferred = true;
    if (this.pushed()) {
      try {
        this.observePage(this.feed);
      } catch (error) {
        this.update({ error });
      }
    }
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
      this.unlisten = this.timing.listen(() => this.wake());
      this.unfollow = this.live?.subscribe(this.client.jobsTopic, (event) =>
        this.received(event),
      );
      // A connected channel sends the page itself; otherwise it is read once.
      if (!this.timing.hidden() && !this.polling && !this.live?.status().connected)
        this.poll();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      this.generation++;
      this.timing.clear(this.timer);
      this.unlisten?.();
      this.unfollow?.();
      this.unfollow = null;
      this.feed = null;
      this.refused = this.deferred = this.again = false;
      for (const controller of this.controllers) controller.abort();
    };
  }
  // Polling runs only while a job is tracked or an upload group is watched, never
  // from a hidden tab, and not while the push alone follows them (`force`: once more).
  // Without the channel an idle explorer reads /jobs on mount and on return.
  schedule(force = false) {
    this.timing.clear(this.timer);
    if (!this.listeners.size || this.timing.hidden()) return;
    if (this.tracked.size === 0 && this.uploads.watched.size === 0) return;
    if (!force && this.pushed() && this.followed()) return;
    this.timer = this.timing.timer(() => this.poll(), 1500);
  }
  // A started job or a newly watched upload is read once more; an in-flight poll
  // re-arms the timer itself when it settles.
  resume() {
    if (!this.polling) this.schedule(true);
  }
  // A visible tab reads once at once, unless pushes already follow it; a hidden one
  // stops.
  wake() {
    if (!this.listeners.size) return;
    if (this.timing.hidden()) return this.timing.clear(this.timer);
    if (this.pushed() && !this.deferred) return this.schedule();
    this.deferred = false;
    this.poll();
  }
  poll() {
    this.timing.clear(this.timer);
    if (this.polling || !this.listeners.size) return;
    this.polling = true;
    this.refresh()
      .catch(() => {})
      .finally(() => {
        this.polling = false;
        // A push that arrived during this read is read now, or once the tab is shown.
        const again = this.again;
        this.again = false;
        if (again && this.timing.hidden()) this.deferred = true;
        if (again && !this.deferred) this.poll();
        else this.schedule();
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
    job = this.latest(job);
    this.invalidateManifest(job);
    const tracking = track || this.tracked.has(job.id);
    if (tracking) this.tracked.set(job.id, job);
    this.update({
      history: this.overlayHistory([job]),
      jobs: this.boundedJobs([...this.state.jobs, job]),
    });
    if (track) this.resume();
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
    if (this.tracked.size) this.resume();
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
