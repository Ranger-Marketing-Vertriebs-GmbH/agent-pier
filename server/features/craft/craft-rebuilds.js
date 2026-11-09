import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { logCraftFailure } from "./craft-log.js";
import {
  createProjectFolder,
  initRepository,
  projectFolderName,
} from "../projects/project-folder.js";
import { CraftMcpClient } from "./craft-mcp-client.js";
import { RebuildChildren } from "./rebuild-children.js";
import {
  cleanAnswer,
  cleanRequest,
  cleanRequestId,
  cleanSettings,
  cleanStart,
} from "./rebuild-input.js";
import { RebuildSampler } from "./rebuild-sampler.js";
import { RebuildStore } from "./rebuild-store.js";
import {
  activeStatuses,
  initialFields,
  pausedFields,
  rebuildView,
  viewChanged,
} from "./rebuild-view.js";

const messages = serverMessages.craft;
const refuse = (message) => problem(message, 409);
const ignored = ["capture/", "checks/", "inbox/", "investigation.cany/"];
const START_TIMEOUT_MS = 60000;
const STOP_WAIT_MS = 3000;
const STOP_POLL_MS = 250;

/**
 * The rebuild supervisor: the only caller of Craft Anything's rebuild_start. It
 * creates each rebuild's project folder, runs the builds in its own MCP children (one
 * per account and mode, rebuild-children.js), samples every running build each
 * `sampleMs` (2 s) while any runs and answers approvals itself in auto mode
 * (rebuild-sampler.js), keeps the
 * records in rebuilds.json and announces changes through `onChange` (`{ id }` for one
 * rebuild's view, `{ list: true }` when rebuilds or the defaults come or go). Nothing
 * restarts on its own: a build interrupted by a shutdown or a lost child reads paused.
 */
export class CraftRebuilds {
  constructor({
    dataDir,
    craft,
    accounts,
    preferences,
    memory,
    barrier = { run: (fn) => fn() },
    clientFactory = (options) => CraftMcpClient.start(options),
    now = () => new Date(),
    timers = { setTimeout, clearTimeout },
    sampleMs = 2000,
    idleMs = 60000,
  }) {
    Object.assign(this, { craft, accounts, preferences, memory, now, timers, sampleMs });
    this.barrier = barrier;
    this.store = new RebuildStore(dataDir);
    const saved = this.store.load();
    this.saved = saved.settings;
    this.records = new Map(saved.records.map((item) => [item.id, item]));
    // The records of the previous server, which restore() reads paused or failed.
    this.unrestored = new Set(this.records.keys());
    this.listeners = new Set();
    this.chains = new Map();
    this.starting = new Map();
    // Rebuilds paused while rebuild_start was still on its way: stopped once it returns.
    this.pauseAfterStart = new Set();
    this.sampler = new RebuildSampler(this);
    this.closing = false;
    this.children = new RebuildChildren({
      dataDir,
      craft,
      accounts,
      clientFactory,
      timers,
      idleMs,
      running: (key) => this.runningOn(key).length > 0,
      lost: (key) => this.childLost(key),
    });
  }

  // --- Reading ------------------------------------------------------------------

  list() {
    return [...this.records.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(rebuildView);
  }

  get(id) {
    const record = this.records.get(id);
    return record ? rebuildView(record) : null;
  }

  /** The rebuild `source` started with `requestId` (its view), or null. */
  startedWith(source, requestId) {
    const record = [...this.records.values()].find(
      (item) => item.source === source && item.requestId === requestId,
    );
    return record ? rebuildView(record) : null;
  }

  /**
   * Whether a rebuild runs or starts, or a child of the rebuilds is alive: removing,
   * updating or changing Craft Anything is refused meanwhile.
   */
  inUse() {
    return (
      this.starting.size > 0 ||
      [...this.records.values()].some((record) => record.running) ||
      this.children.size > 0
    );
  }

  /** The `requestId` a rebuild was started with, or null. */
  requestIdOf(id) {
    return this.records.get(id)?.requestId ?? null;
  }

  /** `listener({ id } | { list: true })`; returns an unsubscribe function. */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The Claude accounts a rebuild may use: `[{ id, name }]`. */
  eligibleAccounts() {
    return this.accounts
      .list()
      .filter((account) => this.preferences.eligible(account, "claude"))
      .map(({ id, name }) => ({ id, name }));
  }

  /** The owner's defaults, with the account that new rebuilds actually use. */
  settings() {
    return { ...this.saved, accountId: this.defaultAccount() };
  }

  async saveSettings(input) {
    const next = cleanSettings(input);
    if (next.accountId !== null) this.requireEligible(next.accountId);
    this.saved = next;
    this.persist();
    this.emit({ list: true });
    return this.settings();
  }

  /** The last `limit` (1–500, default 200) lines of a rebuild's activity. */
  async activity(id, { limit } = {}) {
    const record = this.require(id);
    if (!record.craftProject) return { lines: [] };
    const count = Number.isInteger(limit) ? Math.min(500, Math.max(1, limit)) : 200;
    const result = await this.call(record, "rebuild_activity_show", { limit: count });
    return {
      lines: Array.isArray(result?.lines)
        ? result.lines.filter((line) => typeof line === "string")
        : [],
    };
  }

  // --- Starting ---------------------------------------------------------------------
  /**
   * Starts a rebuild for `source` ("owner", "session" or "agent"). Only the owner
   * chooses account, mode, auto mode and rounds. A retried start with the same
   * `requestId` from the same source returns the rebuild it started.
   */
  async start(input, { source = "owner" } = {}) {
    if (this.closing) throw refuse(messages.rebuildsStopping);
    if (!this.craft.state().installed) throw refuse(messages.notInstalled);
    const requestId = cleanRequestId(input?.requestId);
    if (requestId) {
      const known = this.startedWith(source, requestId);
      if (known) return known;
      const key = `${source}\n${requestId}`;
      if (this.starting.has(key)) return this.starting.get(key);
      const work = this.begin(input, source, requestId);
      this.starting.set(key, work);
      return work.finally(() => this.starting.delete(key));
    }
    return this.begin(input, source, null);
  }

  /**
   * Creates the folder and the record, has Craft Anything start, then makes the folder
   * a Git project. Only the folder and project changes hold a mutation lease
   * (`barrier`, MutationBarrier#run): snapshots (backups) must see them whole. Spawning
   * a child and the rebuild_start round-trip may take up to about 90 s and change only
   * the folder's contents and the rebuild records, which the sampler writes without a
   * lease anyway, so a snapshot never waits for them.
   */
  async begin(input, source, requestId) {
    const options = cleanStart(input, source, this.settings());
    this.requireEligible(options.accountId);
    const { made, record } = await this.barrier.run(async () => {
      const folder = await createProjectFolder({
        preferences: this.preferences,
        memory: this.memory,
        name: projectFolderName(options.request),
        git: false,
        unique: true,
        label: "Rebuild folder",
      });
      const stamp = this.now().toISOString();
      const created = {
        id: randomUUID(),
        projectId: folder.project.id,
        folder: folder.path,
        name: path.basename(folder.path),
        ...options,
        source,
        requestId,
        createdAt: stamp,
        updatedAt: stamp,
        craftProject: null,
        ...initialFields(),
      };
      this.records.set(created.id, created);
      this.persist();
      return { made: folder, record: created };
    });
    this.emit({ list: true });
    try {
      const started = await this.call(
        record,
        "rebuild_start",
        {
          request: record.request,
          target: record.target,
          build_with: record.stack,
          ...(record.rounds && { rounds: record.rounds }),
          project_folder: record.folder,
        },
        { timeoutMs: START_TIMEOUT_MS, project: false },
      );
      if (typeof started?.project !== "string" || !started.project)
        throw new Error("rebuild_start named no project.");
      record.craftProject = started.project;
    } catch (error) {
      // A timeout or a malformed answer may still have started a build.
      await this.stopUnanswered(record);
      this.pauseAfterStart.delete(record.id);
      await this.barrier.run(async () => {
        this.records.delete(record.id);
        this.persist();
        await made.rollback();
      });
      this.emit({ list: true });
      throw this.failure(error);
    }
    await this.barrier.run(async () => {
      const project = await this.prepareFolder(made);
      if (project?.id) record.projectId = project.id;
      this.persist();
    });
    if (this.pauseAfterStart.delete(record.id))
      await this.serial(record.id, () => this.stop(record));
    else await this.serial(record.id, () => this.launched(record));
    return this.get(record.id);
  }

  /**
   * rebuild_start failed (timed out, answered without a project): Craft Anything may
   * still build in the folder that is about to go. Its project, when craft.json already names it, is stopped (best
   * effort).
   */
  async stopUnanswered(record) {
    try {
      const saved = JSON.parse(
        await fs.readFile(path.join(record.folder, "craft.json"), "utf8"),
      );
      if (typeof saved?.project !== "string" || !saved.project) return;
      await this.call({ ...record, craftProject: saved.project }, "rebuild_stop", {});
    } catch {
      // Nothing recorded yet, or the child is gone: nothing left to stop here.
    }
  }

  /**
   * Keeps Craft Anything's records out of Git and makes the folder a repository. The
   * folder is registered again then, which moves its project to the Git identity at
   * once (ProjectMemory#register): that project, or null when this failed.
   */
  async prepareFolder(made) {
    try {
      await fs.writeFile(path.join(made.path, ".gitignore"), `${ignored.join("\n")}\n`, {
        flag: "wx",
      });
      await initRepository(made.path);
      return await this.memory.register(made.path);
    } catch (error) {
      logCraftFailure("prepare a rebuild's project folder", error);
      return null;
    } finally {
      await made.release();
    }
  }

  // --- Acting on a rebuild ----------------------------------------------------------

  /** Sends a follow-up request to the rebuild's project (a new round). */
  async followUp(id, request) {
    const record = this.require(id);
    const text = cleanRequest(request);
    return this.serial(id, async () => {
      this.requireIdle(record);
      await this.call(record, "rebuild_start", { request: text });
      return this.launched(record);
    });
  }

  /** Resumes a paused rebuild (Craft Anything 0.5.0 wants its request again). */
  async continue(id) {
    const record = this.require(id);
    return this.serial(id, async () => {
      this.requireIdle(record);
      const { request } = record;
      await this.call(record, "rebuild_start", { resume: true, request });
      return this.launched(record);
    });
  }

  /**
   * Stops the build (`rebuild_stop`); Continue resumes it. A rebuild still starting is
   * stopped as soon as rebuild_start returns, and reads paused then.
   */
  async pause(id) {
    const record = this.require(id);
    if (record.running && !record.craftProject) {
      this.pauseAfterStart.add(id);
      return this.get(id);
    }
    return this.serial(id, () => this.stop(record));
  }

  async stop(record) {
    const client = this.children.peek(record.accountId, record.mode);
    if (record.running && client && record.craftProject) {
      await this.call(record, "rebuild_stop", {});
      await this.stopped(record);
      await this.sample(record);
    }
    if (record.running) this.update(record, pausedFields(record));
    return this.get(record.id);
  }

  /**
   * Waits up to STOP_WAIT_MS until Craft Anything no longer reports the build running:
   * 0.5.0 still does for a moment after rebuild_stop answered.
   */
  async stopped(record) {
    for (let waited = 0; waited < STOP_WAIT_MS; waited += STOP_POLL_MS) {
      const status = await this.call(record, "rebuild_status", {});
      if (!status?.running && !status?.queued) return;
      await new Promise((resolve) => this.timers.setTimeout(resolve, STOP_POLL_MS));
    }
  }

  /** Answers a question or approval through project_inbox_answer. */
  async answer(id, questionId, input) {
    const record = this.require(id);
    const answer = cleanAnswer(questionId, input);
    return this.serial(id, async () => {
      // Answered already (another tab, the inbox) or never asked: Craft is not asked.
      if (!record.craftProject || !record.questions.some((q) => q.id === questionId))
        throw refuse(messages.rebuildQuestionGone);
      try {
        await this.call(record, "project_inbox_answer", { id: questionId, ...answer });
      } catch (error) {
        // A refused answer reads the rebuild again: a question Craft Anything no longer
        // lists (unknown, or left behind by a paused build) is gone for the owner too.
        await this.sample(record).catch(() => {});
        const listed = record.questions.some((q) => q.id === questionId);
        if (!listed || /not_found$/.test(String(error.code)))
          throw refuse(messages.rebuildQuestionGone);
        throw error;
      }
      await this.sample(record);
      return this.get(id);
    });
  }

  /** Switches auto mode: Craft Anything decides questions, approvals are allowed. */
  async setAutoMode(id, on) {
    const record = this.require(id);
    if (typeof on !== "boolean") throw problem(messages.rebuildAutoModeInvalid, 400);
    return this.serial(id, async () => {
      this.update(record, { autoMode: on });
      if (record.craftProject && this.children.peek(record.accountId, record.mode)) {
        await this.setQuestions(record);
        if (record.running) await this.sample(record);
      }
      return this.get(id);
    });
  }

  // --- Server lifetime --------------------------------------------------------------

  /**
   * Server start: nothing restarts on its own. What the previous server's children
   * left running (a crash, a forced exit) is ended first. A build that ran when
   * AgentPier stopped reads paused; one whose start never reached Craft Anything reads
   * failed. Rebuilds this server started before restore() runs are left alone; a
   * child a view started for a paused one meanwhile idles out as usual.
   */
  async restore() {
    await this.children
      .reap()
      .catch((error) => logCraftFailure("end the rebuilds' left-over processes", error));
    let changed = false;
    for (const id of this.unrestored) {
      const record = this.records.get(id);
      if (!record || (!record.running && !activeStatuses.has(record.status))) continue;
      Object.assign(record, pausedFields(record));
      if (!record.craftProject) record.status = "failed";
      record.updatedAt = this.now().toISOString();
      changed = true;
      this.children.settle(record.accountId, record.mode);
    }
    this.unrestored.clear();
    if (!changed) return;
    this.persist();
    this.emit({ list: true });
  }

  /** Stops every build and child; the interrupted rebuilds read paused. */
  async close() {
    this.closing = true;
    this.sampler.stop();
    await this.children.close((key) =>
      this.runningOn(key)
        .map((item) => item.craftProject)
        .filter(Boolean),
    );
    for (const record of this.records.values())
      if (record.running) this.update(record, pausedFields(record));
  }

  // --- Sampling ---------------------------------------------------------------------

  /** After a start, follow-up or resume: question mode, a first sample, the sampler. */
  async launched(record) {
    this.unrestored.delete(record.id);
    this.update(record, { running: true });
    await this.setQuestions(record).catch((error) =>
      logCraftFailure("set a rebuild's question mode", error),
    );
    await this.sample(record).catch((error) => logCraftFailure("read a rebuild", error));
    this.schedule();
    return this.get(record.id);
  }

  setQuestions(record) {
    return this.call(record, "project_questions_set", {
      mode: record.autoMode ? "decide" : "ask",
    });
  }

  schedule() {
    this.sampler.schedule();
  }

  sample(record, options) {
    return this.sampler.sample(record, options);
  }

  /** The child of `key` died: its running rebuilds read paused (Continue resumes). */
  childLost(key) {
    for (const record of this.runningOn(key)) this.update(record, pausedFields(record));
  }

  // --- Helpers ----------------------------------------------------------------------

  runningOn(key) {
    return [...this.records.values()].filter(
      (record) =>
        record.running && this.children.key(record.accountId, record.mode) === key,
    );
  }

  /** Calls `name` on the rebuild's child (started when needed) for its project. */
  call(record, name, args, { timeoutMs, project = true } = {}) {
    if (project && !record.craftProject) throw refuse(messages.rebuildNeverStarted);
    return this.children
      .use(record.accountId, record.mode, (client) =>
        client.call(
          name,
          project ? { project: record.craftProject, ...args } : args,
          timeoutMs ? { timeoutMs } : undefined,
        ),
      )
      .catch((error) => {
        throw this.failure(error);
      });
  }

  /** A Craft Anything or client failure as a 409 problem; problems pass through. */
  failure(error) {
    if (error?.status) return error;
    return Object.assign(problem(messages.rebuildUnavailable(error.message), 409), {
      code: error.code,
    });
  }

  /** Applies `fields`; stores and announces the record when its view changed. */
  update(record, fields) {
    const before = structuredClone(record);
    Object.assign(record, fields);
    if (!viewChanged(before, record)) {
      if (before.running !== record.running) this.persist();
      return;
    }
    record.updatedAt = this.now().toISOString();
    this.persist();
    this.emit({ id: record.id });
  }

  /** Runs `work` after the rebuild's earlier work, so samples and actions never mix. */
  serial(id, work) {
    const run = (this.chains.get(id) ?? Promise.resolve()).then(work);
    const settled = run.catch(() => {});
    this.chains.set(id, settled);
    settled.then(() => {
      if (this.chains.get(id) === settled) this.chains.delete(id);
    });
    return run;
  }

  require(id) {
    const record = this.records.get(id);
    if (!record) throw problem(messages.rebuildNotFound, 404);
    return record;
  }

  requireIdle(record) {
    if (!record.craftProject) throw refuse(messages.rebuildNeverStarted);
    if (record.running) throw refuse(messages.rebuildRunning);
    this.requireEligible(record.accountId);
  }

  eligible(accountId) {
    const account = this.accounts.list().find((item) => item.id === accountId);
    return !!account && this.preferences.eligible(account, "claude");
  }

  requireEligible(accountId) {
    if (!this.eligible(accountId)) throw refuse(messages.rebuildAccountIneligible);
  }

  /** The saved account when still eligible, else the default Claude account. */
  defaultAccount() {
    if (this.saved.accountId && this.eligible(this.saved.accountId))
      return this.saved.accountId;
    return this.preferences.get().defaultAccountIds?.claude ?? "local-claude";
  }

  persist() {
    try {
      this.store.save({ settings: this.saved, records: [...this.records.values()] });
    } catch (error) {
      logCraftFailure("save the Craft Anything rebuilds", error);
    }
  }

  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        logCraftFailure("announce a rebuild", error);
      }
    }
  }
}
