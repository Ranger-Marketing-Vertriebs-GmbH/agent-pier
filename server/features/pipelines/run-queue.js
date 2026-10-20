import { serverMessages } from "../../lib/i18n/de.js";
import { randomUUID } from "node:crypto";
import { problem } from "../../lib/storage.js";
import { QueueStore } from "./queue-store.js";
import { itemsToStart } from "./queue-policy.js";
import { runId } from "./run-store.js";
import { tokenBudgetValue } from "./run-budget.js";

const copy = serverMessages.pipelineQueue;
// Waiting items per project, and started items kept to show their runs.
export const MAX_WAITING_ITEMS = 200;
export const KEPT_STARTED_ITEMS = 50;
const controlCharacters = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function optionalText(value, max, message) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw problem(message);
  const text = value.trim();
  if (text.length > max || controlCharacters.test(text)) throw problem(message);
  return text || null;
}
function taskValue(task) {
  if (typeof task !== "string" || !task.trim() || Buffer.byteLength(task) > 65536)
    throw problem(copy.invalidTask);
  return task;
}

/**
 * A run queue per registered project. Items wait in order; while fewer of the
 * project's runs are active than its limit (see queue-policy.js), the next item is
 * claimed and started with the run id reserved when it was added. Claiming is saved
 * before the start, so a restart between both resumes the same start: the engine
 * refuses a second run with that id, and an existing run marks the item started.
 */
export class RunQueue {
  constructor({
    dataDir,
    engine,
    definitions,
    projects,
    audit,
    onChange = () => {},
    onError = () => {},
    pollIntervalMs = 5000,
    clock = Date,
  }) {
    this.store = new QueueStore(dataDir);
    Object.assign(this, { engine, definitions, projects, audit, onChange, onError });
    this.clock = clock;
    this.closed = false;
    this.dirty = false;
    this.draining = null;
    // Events can be missed while closed or on errors; a slow poll catches up.
    if (pollIntervalMs > 0) {
      this.timer = setInterval(() => this.changed(), pollIntervalMs);
      this.timer.unref();
    }
  }
  now() {
    return new Date(
      typeof this.clock.now === "function" ? this.clock.now() : Date.now(),
    ).toISOString();
  }
  settings(projectId) {
    return this.definitions.getQueueSettings(projectId);
  }
  /** A project's settings and items, with the state of each started run. */
  view(projectId) {
    this.projects(projectId);
    const { limit, countParked } = this.settings(projectId);
    return {
      projectId,
      settings: { limit, countParked },
      items: this.store.list(projectId).map((item) => this.present(item)),
    };
  }
  present(item) {
    const shown = { ...item };
    delete shown.cwd;
    if (item.state !== "started") return shown;
    try {
      const run = this.engine.store.get(item.id);
      shown.run = {
        status: run.status,
        phase: run.phase,
        currentNodeId: run.currentNodeId,
        ...(run.failDetail ? { failDetail: run.failDetail } : {}),
      };
    } catch (error) {
      if (error.status !== 404) throw error;
      // The run was deleted after it finished.
      shown.run = null;
    }
    return shown;
  }
  find(id) {
    return this.store.find(id);
  }
  item(projectId, id) {
    return this.present(this.store.get(projectId, id));
  }
  open() {
    if (this.closed) throw problem(copy.closed, 503);
  }
  /**
   * Adds an item at the end of the project's queue. `id` is a run id reserved by the
   * caller (an MCP start receipt); `source` names who queued it.
   */
  add(projectId, input = {}, { id, source = { kind: "user" } } = {}) {
    this.open();
    const project = this.projects(projectId);
    const task = taskValue(input.task);
    const baseBranch = optionalText(input.baseBranch, 300, copy.invalidBaseBranch);
    const externalRef = optionalText(input.externalRef, 120, copy.invalidExternalRef);
    const tokenBudget = tokenBudgetValue(input.tokenBudget);
    // The definition must be startable now; a later change fails its start instead.
    const { pipeline } = this.definitions.snapshot(input.pipelineId);
    if (
      this.store.count(projectId, ["queued", "starting", "failed"]) >= MAX_WAITING_ITEMS
    )
      throw problem(copy.full, 409);
    const item = this.store.insert({
      id: id === undefined ? randomUUID() : runId(id),
      projectId,
      cwd: project.cwd,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      task,
      baseBranch,
      tokenBudget,
      externalRef,
      source,
      state: "queued",
      error: null,
      createdAt: this.now(),
      startedAt: null,
    });
    this.notify(projectId);
    return this.present(item);
  }
  /**
   * Removes an item. A waiting item never starts; a started item only leaves the list
   * and its run continues. `waitingOnly` refuses started items.
   */
  remove(projectId, id, { waitingOnly = false } = {}) {
    this.open();
    const item = this.store.get(projectId, id);
    if (item.state === "starting") throw problem(copy.starting, 409);
    if (waitingOnly && item.state === "started") throw problem(copy.notWaiting, 409);
    this.store.remove(item.id);
    this.notify(projectId);
    return item;
  }
  /** Queues an item whose start failed again, at its old position. */
  retry(projectId, id) {
    this.open();
    const item = this.store.get(projectId, id);
    if (item.state !== "failed") throw problem(copy.notFailed, 409);
    this.store.save({ ...item, state: "queued", error: null });
    this.notify(projectId);
    return this.item(projectId, id);
  }
  /** Moves a waiting item before the previous or after the next waiting item. */
  move(projectId, id, direction) {
    this.open();
    if (!["up", "down"].includes(direction)) throw problem(copy.invalidMove);
    const item = this.store.get(projectId, id);
    if (!["queued", "failed"].includes(item.state)) throw problem(copy.notWaiting, 409);
    const waiting = this.store
      .list(projectId)
      .filter((other) => ["queued", "failed"].includes(other.state));
    const index = waiting.findIndex((other) => other.id === item.id);
    const neighbour = waiting[direction === "up" ? index - 1 : index + 1];
    if (neighbour) this.store.swap(item, neighbour);
    this.notify(projectId);
    return this.view(projectId);
  }
  notify(projectId) {
    this.onChange(projectId);
    this.changed();
  }
  /** Schedules a pass over the queues; resolves when the queue is idle again. */
  changed() {
    this.dirty = true;
    if (!this.closed) this.draining ??= this.drain();
    return this.draining || Promise.resolve();
  }
  async drain() {
    try {
      // Let the change that triggered this (a run save) finish first.
      await new Promise((resolve) => setImmediate(resolve));
      while (this.dirty && !this.closed) {
        this.dirty = false;
        await this.schedule().catch((error) => this.onError(error));
      }
    } finally {
      this.draining = null;
    }
  }
  activeRuns() {
    return [
      ...this.engine.store.withStatus("running"),
      ...this.engine.store.withStatus("awaiting-human"),
    ];
  }
  async schedule() {
    for (const projectId of this.store.projectsWithState("queued")) {
      const settings = this.settings(projectId);
      while (!this.closed) {
        const [next] = itemsToStart({
          projectId,
          items: this.store.list(projectId),
          runs: this.activeRuns(),
          settings,
        });
        if (!next) break;
        await this.launch(this.store.save({ ...next, state: "starting" }));
      }
    }
  }
  runExists(id) {
    try {
      this.engine.store.get(id);
      return true;
    } catch (error) {
      if (error.status === 404) return false;
      throw error;
    }
  }
  async launch(item) {
    this.onChange(item.projectId);
    try {
      await this.engine.start(
        {
          pipelineId: item.pipelineId,
          cwd: item.cwd,
          task: item.task,
          ...(item.baseBranch ? { baseBranch: item.baseBranch } : {}),
          ...(item.tokenBudget !== null ? { tokenBudget: item.tokenBudget } : {}),
        },
        { id: item.id, expectedProjectId: item.projectId },
      );
    } catch (error) {
      // A shutdown keeps the claim; the next start of AgentPier resumes it.
      if (this.closed || this.engine.closing || this.engine.closed) return;
      if (!this.runExists(item.id)) {
        // A refused start explains itself on the item; anything else is logged too.
        if (![400, 403, 404, 409].includes(error.status)) this.onError(error);
        this.store.save({
          ...item,
          state: "failed",
          error: [400, 403, 404, 409].includes(error.status)
            ? String(error.message).slice(0, 500)
            : copy.startFailed,
        });
        this.onChange(item.projectId);
        return;
      }
    }
    this.started(item);
  }
  started(item) {
    this.store.save({ ...item, state: "started", error: null, startedAt: this.now() });
    this.audit?.append({
      action: "pipeline.started",
      resourceType: "pipeline",
      resourceId: item.id,
      projectId: item.projectId,
      source: "system",
      outcome: "success",
      details: { kind: "queue" },
    });
    // Older started items leave the list; their runs stay under Runs.
    const started = this.store
      .list(item.projectId)
      .filter((other) => other.state === "started")
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    for (const old of started.slice(KEPT_STARTED_ITEMS)) this.store.remove(old.id);
    this.onChange(item.projectId);
  }
  /**
   * Resumes claims a restart interrupted: an item whose run exists is started, any
   * other start is repeated with the same reserved id. Then the queues are scheduled.
   */
  async recover() {
    for (const item of this.store.withState("starting")) {
      if (this.closed) return;
      if (this.runExists(item.id)) this.started(item);
      else await this.launch(item);
    }
    // Waiting items start in the background, so a start-up never waits for them.
    this.changed();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await this.draining;
    this.store.close();
  }
}
