import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { logFailure } from "../mcp-packages/package-install-job.js";
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
import { RebuildStore } from "./rebuild-store.js";
import {
  activeStatuses,
  initialFields,
  rebuildView,
  sampledFields,
  viewChanged,
} from "./rebuild-view.js";

const messages = serverMessages.craft;
const refuse = (message) => problem(message, 409);
const ignored = ["capture/", "checks/", "inbox/", "investigation.cany/"];
const START_TIMEOUT_MS = 60000;
// Codes of a client that is gone: the exit handler takes care of the rebuilds.
const goneCodes = new Set(["CRAFT_MCP_CLOSED", "CRAFT_MCP_EXITED"]);
// The sampler reads running rebuilds that Craft Anything already knows.
const sampled = (record) => record.running && !!record.craftProject;

/**
 * The rebuild supervisor: the only caller of Craft Anything's rebuild_start. It
 * creates each rebuild's project folder, runs the builds in its own MCP children (one
 * per account and mode, rebuild-children.js), samples every running build each
 * `sampleMs` (2 s) while any runs, answers approvals itself in auto mode, keeps the
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
    clientFactory = (options) => CraftMcpClient.start(options),
    now = () => new Date(),
    timers = { setTimeout, clearTimeout },
    sampleMs = 2000,
    idleMs = 60000,
  }) {
    Object.assign(this, { craft, accounts, preferences, memory, now, timers, sampleMs });
    this.store = new RebuildStore(dataDir);
    const saved = this.store.load();
    this.saved = saved.settings;
    this.records = new Map(saved.records.map((item) => [item.id, item]));
    this.listeners = new Set();
    this.chains = new Map();
    this.starting = new Map();
    this.approving = new Set();
    // Rebuilds paused while rebuild_start was still on its way: stopped once it returns.
    this.pauseAfterStart = new Set();
    this.sampler = null;
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

  /** `listener({ id } | { list: true })`; returns an unsubscribe function. */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
      const known = [...this.records.values()].find(
        (item) => item.source === source && item.requestId === requestId,
      );
      if (known) return rebuildView(known);
      const key = `${source}\n${requestId}`;
      if (this.starting.has(key)) return this.starting.get(key);
      const work = this.begin(input, source, requestId);
      this.starting.set(key, work);
      return work.finally(() => this.starting.delete(key));
    }
    return this.begin(input, source, null);
  }

  async begin(input, source, requestId) {
    const options = cleanStart(input, source, this.settings());
    this.requireEligible(options.accountId);
    const made = await createProjectFolder({
      preferences: this.preferences,
      memory: this.memory,
      name: projectFolderName(options.request),
      git: false,
      unique: true,
      label: "Rebuild folder",
    });
    const stamp = this.now().toISOString();
    const record = {
      id: randomUUID(),
      projectId: made.project.id,
      folder: made.path,
      name: path.basename(made.path),
      ...options,
      source,
      requestId,
      createdAt: stamp,
      updatedAt: stamp,
      craftProject: null,
      ...initialFields(),
    };
    this.records.set(record.id, record);
    this.persist();
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
      if (error.code === "CRAFT_MCP_TIMEOUT") await this.stopUnanswered(record);
      this.pauseAfterStart.delete(record.id);
      this.records.delete(record.id);
      this.persist();
      this.emit({ list: true });
      await made.rollback();
      throw this.failure(error);
    }
    await this.prepareFolder(made);
    this.persist();
    if (this.pauseAfterStart.delete(record.id))
      await this.serial(record.id, () => this.stop(record));
    else await this.serial(record.id, () => this.launched(record));
    return this.get(record.id);
  }

  /**
   * rebuild_start timed out: Craft Anything may still build in the folder that is
   * about to go. Its project, when craft.json already names it, is stopped (best
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

  /** Keeps Craft Anything's records out of Git and makes the folder a repository. */
  async prepareFolder(made) {
    try {
      await fs.writeFile(path.join(made.path, ".gitignore"), `${ignored.join("\n")}\n`, {
        flag: "wx",
      });
      await initRepository(made.path);
    } catch (error) {
      logFailure("prepare a rebuild's project folder", error);
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

  /** Resumes a paused rebuild where it stopped. */
  async continue(id) {
    const record = this.require(id);
    return this.serial(id, async () => {
      this.requireIdle(record);
      await this.call(record, "rebuild_start", { resume: true });
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
      await this.sample(record);
    }
    if (record.running) this.update(record, { running: false, status: "paused" });
    return this.get(record.id);
  }

  /** Answers a question or approval through project_inbox_answer. */
  async answer(id, questionId, input) {
    const record = this.require(id);
    const answer = cleanAnswer(questionId, input);
    if (!record.craftProject) throw refuse(messages.rebuildQuestionGone);
    return this.serial(id, async () => {
      try {
        await this.call(record, "project_inbox_answer", { id: questionId, ...answer });
      } catch (error) {
        if (/not_found$/.test(String(error.code))) {
          await this.sample(record).catch(() => {});
          throw refuse(messages.rebuildQuestionGone);
        }
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
   * Server start: nothing restarts on its own. A build
   * that ran when AgentPier stopped reads paused; one whose start never reached Craft
   * Anything reads failed.
   */
  async restore() {
    let changed = false;
    for (const record of this.records.values()) {
      if (!record.running && !activeStatuses.has(record.status)) continue;
      record.running = false;
      record.status = record.craftProject ? "paused" : "failed";
      changed = true;
    }
    if (changed) this.persist();
  }

  /** Stops every build and child; the interrupted rebuilds read paused. */
  async close() {
    this.closing = true;
    if (this.sampler) this.timers.clearTimeout(this.sampler);
    this.sampler = null;
    await this.children.close((key) =>
      this.runningOn(key)
        .map((item) => item.craftProject)
        .filter(Boolean),
    );
    for (const record of this.records.values())
      if (record.running) this.update(record, { running: false, status: "paused" });
  }

  // --- Sampling ---------------------------------------------------------------------

  /** After a start, follow-up or resume: question mode, a first sample, the sampler. */
  async launched(record) {
    this.update(record, { running: true });
    await this.setQuestions(record).catch((error) =>
      logFailure("set a rebuild's question mode", error),
    );
    await this.sample(record).catch((error) => logFailure("read a rebuild", error));
    this.schedule();
    return this.get(record.id);
  }

  setQuestions(record) {
    return this.call(record, "project_questions_set", {
      mode: record.autoMode ? "decide" : "ask",
    });
  }

  schedule() {
    if (this.sampler || this.closing) return;
    if (![...this.records.values()].some(sampled)) return;
    this.sampler = this.timers.setTimeout(() => {
      this.sampler = null;
      this.tick().finally(() => this.schedule());
    }, this.sampleMs);
  }

  async tick() {
    const running = [...this.records.values()].filter(sampled);
    await Promise.all(
      running.map((record) =>
        this.serial(record.id, () => this.sample(record)).catch((error) =>
          logFailure("read a rebuild", error),
        ),
      ),
    );
  }

  /**
   * Reads one rebuild from its live child (`rebuild_status` + `project_show`) and, in
   * auto mode, allows its open approvals. A rebuild without a child stops running; one
   * still starting (no Craft project yet) is left to its start.
   */
  async sample(record, { approve = true } = {}) {
    if (!record.craftProject) return;
    const client = this.children.peek(record.accountId, record.mode);
    if (!client) {
      if (record.running) this.update(record, { running: false, status: "paused" });
      return;
    }
    const project = record.craftProject;
    try {
      const status = await client.call("rebuild_status", { project });
      const show = await client.call("project_show", { project });
      this.update(record, sampledFields(status, show, record.step));
      this.forgetApprovals(record);
      if (approve && record.autoMode && (await this.allowApprovals(record, client)))
        await this.sample(record, { approve: false });
    } catch (error) {
      if (!goneCodes.has(error.code)) throw error;
    } finally {
      this.children.settle(record.accountId, record.mode);
    }
  }

  /** Forgets the allowed approvals of `record` that are no longer open. */
  forgetApprovals(record) {
    const open = new Set(record.questions.map((question) => question.id));
    const prefix = `${record.id}\n`;
    for (const key of this.approving)
      if (key.startsWith(prefix) && !open.has(key.slice(prefix.length)))
        this.approving.delete(key);
  }

  /**
   * Auto mode: allows each open approval once (again after a failed try); true when
   * one was answered.
   */
  async allowApprovals(record, client) {
    let answered = false;
    for (const question of record.questions) {
      if (question.kind !== "approval") continue;
      const key = `${record.id}\n${question.id}`;
      if (this.approving.has(key)) continue;
      this.approving.add(key);
      try {
        await client.call("project_inbox_answer", {
          project: record.craftProject,
          id: question.id,
          allow: true,
        });
        answered = true;
      } catch (error) {
        this.approving.delete(key);
        logFailure("allow a rebuild's approval", error);
      }
    }
    return answered;
  }

  /** The child of `key` died: its running rebuilds read paused (Continue resumes). */
  childLost(key) {
    for (const record of this.runningOn(key))
      this.update(record, { running: false, status: "paused" });
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
      logFailure("save the Craft Anything rebuilds", error);
    }
  }

  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        logFailure("announce a rebuild", error);
      }
    }
  }
}
