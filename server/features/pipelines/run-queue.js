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
// A ticket-like reference: letters, digits, spaces and . _ : # / - only, so no
// format, bidi or zero-width characters reach the owner or other clients.
const referencePattern = /^[\p{L}\p{N}][\p{L}\p{N} ._:#/-]{0,119}$/u;

function optionalText(value, max, message, pattern) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw problem(message);
  const text = value.trim();
  if (text.length > max || controlCharacters.test(text)) throw problem(message);
  if (text && pattern && !pattern.test(text)) throw problem(message);
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
    projectMoved = () => null,
    authorize,
    audit,
    onChange = () => {},
    onError = () => {},
    pollIntervalMs = 5000,
    clock = Date,
  }) {
    this.store = new QueueStore(dataDir);
    Object.assign(this, { engine, definitions, projects, projectMoved, audit });
    Object.assign(this, { onChange, onError });
    // Re-checks an MCP client's item before its start (McpTools.queuedStart); until
    // it is set, such items wait.
    this.authorize = authorize;
    this.inFlight = new Set();
    this.clock = clock;
    this.closed = false;
    this.dirty = false;
    this.draining = null;
    // One pass per project at a time: a slow start never holds back another project.
    this.passes = new Map();
    this.dirtyProjects = new Set();
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
   * Validates an item for the project's queue without adding it, so a caller can
   * refuse before it reserves anything (queue_add's request ID).
   */
  check(projectId, input = {}) {
    this.open();
    const project = this.projects(projectId);
    const checked = {
      cwd: project.cwd,
      task: taskValue(input.task),
      baseBranch: optionalText(input.baseBranch, 300, copy.invalidBaseBranch),
      externalRef: optionalText(
        input.externalRef,
        120,
        copy.invalidExternalRef,
        referencePattern,
      ),
      tokenBudget: tokenBudgetValue(input.tokenBudget),
    };
    // The definition must be startable now; a later change fails its start instead.
    const { pipeline } = this.definitions.snapshot(input.pipelineId);
    if (
      this.store.count(projectId, ["queued", "starting", "failed"]) >= MAX_WAITING_ITEMS
    )
      throw problem(copy.full, 409);
    return { ...checked, pipelineId: pipeline.id, pipelineName: pipeline.name };
  }
  /**
   * Adds an item at the end of the project's queue. `id` is a run id reserved by the
   * caller (an MCP start receipt); `source` names who queued it.
   */
  add(projectId, input = {}, { id, source = { kind: "user" } } = {}) {
    const checked = this.check(projectId, input);
    const item = this.store.insert({
      id: id === undefined ? randomUUID() : runId(id),
      projectId,
      ...checked,
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
  /** Whether any item, in any state, still names the project. */
  ownsProject(projectId) {
    return this.store.count(projectId, ["queued", "starting", "failed", "started"]) > 0;
  }
  /**
   * Moves a project's items to the project it became (a folder that became a Git work
   * tree, or a merged duplicate), behind the items already waiting there.
   */
  moveProject(fromId, toId) {
    if (fromId === toId || !this.ownsProject(fromId)) return;
    let cwd = null;
    try {
      cwd = this.projects(toId).cwd;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    this.store.moveProject(fromId, toId, cwd);
    this.notify(toId);
  }
  exists(projectId) {
    try {
      this.projects(projectId);
      return true;
    } catch (error) {
      if (error.status === 404) return false;
      throw error;
    }
  }
  /**
   * A project that is no longer registered: its items follow a recorded rebind, or
   * fail with the reason and never start.
   */
  orphaned(projectId) {
    const target = this.projectMoved(projectId);
    if (target && this.exists(target)) return this.moveProject(projectId, target);
    for (const item of this.store.list(projectId))
      if (
        item.state === "queued" ||
        (item.state === "starting" && !this.inFlight.has(item.id))
      )
        this.fail(item, copy.projectGone, "project-gone");
  }
  notify(projectId) {
    this.onChange(projectId);
    this.changed();
  }
  /** Schedules a pass over the queues; resolves when the queue is idle again. */
  changed() {
    this.dirty = true;
    // Detached from a caller's mutation lease (a run save inside the engine's lock),
    // so every start takes a lease of its own and a backup waits for it.
    const barrier = this.engine.mutationBarrier;
    if (!this.closed)
      this.draining ??= barrier ? barrier.detached(() => this.drain()) : this.drain();
    return this.idle();
  }
  /** Resolves once no pass is pending or running. */
  async idle() {
    while (this.draining || this.passes.size)
      await Promise.all([this.draining, ...this.passes.values()]);
  }
  async drain() {
    try {
      // Let the change that triggered this (a run save) finish first.
      await new Promise((resolve) => setImmediate(resolve));
      while (this.dirty && !this.closed) {
        this.dirty = false;
        try {
          this.schedule();
        } catch (error) {
          this.onError(error);
        }
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
  /** Starts a pass for every project with waiting or interrupted items. */
  schedule() {
    const projects = new Set([
      ...this.store.projectsWithState("starting"),
      ...this.store.projectsWithState("queued"),
    ]);
    for (const projectId of projects) this.pass(projectId);
  }
  /**
   * Runs the project's pass, or marks it to run again when one is already running, so
   * a project never has two passes at once and never starts an item twice.
   */
  pass(projectId) {
    this.dirtyProjects.add(projectId);
    if (this.passes.has(projectId)) return;
    const run = (async () => {
      try {
        while (this.dirtyProjects.delete(projectId) && !this.closed)
          await this.scheduleProject(projectId).catch((error) => this.onError(error));
      } finally {
        this.passes.delete(projectId);
      }
    })();
    this.passes.set(projectId, run);
  }
  async scheduleProject(projectId) {
    if (!this.exists(projectId)) return this.orphaned(projectId);
    // Claims a restart interrupted start again with their reserved ids. Each item is
    // read again right before, since an earlier resume or a merge may have changed it.
    for (const { id } of this.store.list(projectId)) {
      const item = this.store.find(id);
      if (
        item?.state === "starting" &&
        item.projectId === projectId &&
        !this.inFlight.has(id) &&
        !this.closed
      )
        await this.resume(item);
    }
    const settings = this.settings(projectId);
    while (!this.closed) {
      const [next] = itemsToStart({
        projectId,
        items: this.store.list(projectId),
        runs: this.activeRuns(),
        settings,
      });
      // A client's item waits until its grant can be checked.
      if (!next || (next.source?.kind === "mcp" && !this.authorize)) break;
      await this.launch(this.store.save({ ...next, state: "starting" }));
    }
  }
  async resume(item) {
    if (this.runExists(item.id)) return this.started(item);
    if (item.source?.kind === "mcp" && !this.authorize) return;
    await this.launch(item);
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
    this.inFlight.add(item.id);
    try {
      await this.attempt(item);
    } finally {
      this.inFlight.delete(item.id);
    }
  }
  /**
   * The grant that queued a client's item must still allow this start, and its token
   * budget is held to the pipeline's current bound (see McpTools.queuedStart).
   */
  async authorized(item) {
    if (item.source?.kind !== "mcp") return item;
    let checked;
    try {
      checked = await this.authorize(item);
    } catch (error) {
      if (error.status !== 403) throw error;
      this.fail(item, error.message, error.failReason || "grant-revoked");
      return null;
    }
    if (checked.tokenBudget === item.tokenBudget) return item;
    // Capped to the pipeline's lowered budget; the item and the audit log say so.
    const changes = {
      tokenBudget: checked.tokenBudget,
      budgetCapped: { from: item.tokenBudget, to: checked.tokenBudget },
    };
    this.update(item, changes);
    const capped = { ...item, ...changes };
    this.audit?.append({
      action: "pipeline.updated",
      resourceType: "pipeline",
      resourceId: item.id,
      projectId: item.projectId,
      source: "system",
      outcome: "success",
      details: {
        kind: "budget",
        from: item.tokenBudget,
        to: checked.tokenBudget,
        usedTokens: 0,
      },
    });
    return capped;
  }
  async attempt(claimed) {
    this.onChange(claimed.projectId);
    let item = claimed;
    try {
      item = await this.authorized(claimed);
      if (!item) return;
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
        const refused = [400, 403, 404, 409].includes(error.status);
        if (!refused) this.onError(error);
        this.fail(item, refused ? String(error.message).slice(0, 500) : copy.startFailed);
        return;
      }
    }
    this.started(item);
  }
  /**
   * Saves changes onto the item as stored now, so a project move that happened while
   * the item was being started keeps the item in the moved project at its new place.
   */
  update(item, changes) {
    const stored = this.store.find(item.id) || item;
    return this.store.save({ ...stored, ...changes });
  }
  /** Marks an item failed with its reason; `failReason` also records it in the audit log. */
  fail(claimed, error, failReason) {
    const item = this.update(claimed, { state: "failed", error });
    if (failReason)
      this.audit?.append({
        action: "pipeline.failed",
        resourceType: "pipeline",
        resourceId: item.id,
        projectId: item.projectId,
        source: "system",
        outcome: "failure",
        details: { kind: "queue", failReason },
      });
    this.onChange(item.projectId);
  }
  started(claimed) {
    const item = this.update(claimed, {
      state: "started",
      error: null,
      startedAt: this.now(),
    });
    let run = null;
    try {
      run = this.engine.store.get(item.id);
    } catch (error) {
      // The run may already be deleted; anything else is logged, and the start is
      // still recorded, without its budget.
      if (error.status !== 404) this.onError(error);
    }
    // Like every start: the budget the run spends against and who set it.
    const tokenBudget = run?.tokenBudget ?? null;
    this.audit?.append({
      action: "pipeline.started",
      resourceType: "pipeline",
      resourceId: item.id,
      projectId: item.projectId,
      source: "system",
      outcome: "success",
      details: {
        kind: "queue",
        tokenBudget,
        tokenBudgetSource:
          item.tokenBudget !== null ? "start" : tokenBudget ? "pipeline" : null,
      },
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
   * Resumes claims a restart interrupted: an item whose run exists is started now;
   * every other start is repeated with the same reserved id by the background pass,
   * like waiting items, so a start-up never waits for a worktree.
   */
  recover() {
    for (const item of this.store.withState("starting"))
      if (this.runExists(item.id)) this.started(item);
    this.changed();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await this.idle();
    this.store.close();
  }
}
