import { fileErrorMessage } from "../../lib/i18n/messages/files.js";

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
    this.state = { jobs: [], entries: {}, error: null };
    this.listeners = new Set();
    this.tracked = new Map();
    this.tail = Promise.resolve();
    this.generation = 0;
    this.controllers = new Set();
    this.subscribe = this.subscribe.bind(this);
    this.getSnapshot = () => this.state;
    this.start = (scopeId, operation) =>
      this.action(
        "/operations",
        scopeId,
        {
          requestId: `${Date.now()}:${crypto.randomUUID()}`,
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
          await this.readEntries(options.jobId, options.cursor, signal, owns);
          return;
        }
        const history = await this.client.get("/jobs", {}, signal);
        if (!owns()) return;
        if (!Array.isArray(history.jobs)) throw issue("FILE_INVALID_RESPONSE");
        this.update({
          jobs: [
            ...new Map(
              [...history.jobs, ...this.tracked.values()].map((job) => [job.id, job]),
            ).values(),
          ],
        });
        for (const id of this.tracked.keys()) {
          const job = await this.client.get(
            `/jobs/${encodeURIComponent(id)}`,
            {},
            signal,
          );
          if (!owns()) return;
          this.accept(job, true);
          if (job.kind === "search") await this.readEntries(id, undefined, signal, owns);
        }
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
    if (track || this.tracked.has(job.id)) this.tracked.set(job.id, job);
    this.update({
      jobs: [
        ...new Map([...this.state.jobs, job].map((value) => [value.id, value])).values(),
      ],
    });
  }
  action(suffix, scopeId, body, track = false) {
    return this.enqueue(async (signal, owns) => {
      const job = await this.client.mutate(suffix, { scopeId, body, signal });
      if (!owns()) return;
      if (job.scopeId !== scopeId) throw issue("FILE_INVALID_SCOPE");
      this.accept(job, track);
      return job;
    });
  }
  async readEntries(id, cursor, signal, owns) {
    const prior = this.state.entries[id];
    cursor ??= prior?.tailCursor;
    const page = await this.client.get(
      `/jobs/${encodeURIComponent(id)}/entries`,
      { cursor },
      signal,
    );
    if (!owns()) return;
    if (!Array.isArray(page.entries)) throw issue("FILE_INVALID_RESPONSE");
    const entries = [
      ...new Map(
        [...(prior?.entries || []), ...page.entries].map((entry) => [entry.id, entry]),
      ).values(),
    ];
    this.update({
      entries: {
        ...this.state.entries,
        [id]: {
          entries,
          nextCursor: page.nextCursor,
          tailCursor: cursor ?? null,
          paged: Boolean(cursor || prior?.paged),
        },
      },
    });
  }
}
