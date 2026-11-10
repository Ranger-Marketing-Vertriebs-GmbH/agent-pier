import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { logCraftFailure } from "./craft-log.js";
import { CraftMcpClient } from "./craft-mcp-client.js";
import { RebuildChildren } from "./rebuild-children.js";
import {
  cleanAnswer,
  cleanRequest,
  cleanRequestId,
  cleanSettings,
} from "./rebuild-input.js";
import { cleanPictureIds, RebuildPictures } from "./rebuild-pictures.js";
import { beginRebuild } from "./rebuild-start.js";
import { RebuildSampler } from "./rebuild-sampler.js";
import { RebuildStore } from "./rebuild-store.js";
import {
  activeStatuses,
  pausedFields,
  rebuildView,
  viewChanged,
} from "./rebuild-view.js";

const messages = serverMessages.craft;
const refuse = (message) => problem(message, 409);
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
    // Pictures waiting for a start or follow-up; an earlier process's leftovers go.
    this.pictures = new RebuildPictures({ dataDir });
    this.pictures.clear();
    this.pictures.start();
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
   * Whether a rebuild runs or starts, or a call of a rebuild child is in flight (a
   * Continue, a follow-up, a read): removing, updating or changing Craft Anything is
   * refused meanwhile. Idle children do not count; closeIdle() ends them first.
   */
  inUse() {
    return (
      this.starting.size > 0 ||
      this.children.busy ||
      [...this.records.values()].some((record) => record.running)
    );
  }

  /** Closes the children no running rebuild uses (before Craft Anything changes). */
  closeIdle() {
    return this.children.closeIdle();
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
   * `requestId` from the same source returns the rebuild it started. The staged
   * `pictures` of the call go whatever happens: the start that uses them takes them
   * first (beginRebuild), so a retry joining it releases nothing of them.
   */
  async start(input, options) {
    try {
      return await this.startOnce(input, options);
    } finally {
      this.pictures.release(input?.pictures);
    }
  }

  async startOnce(input, { source = "owner" } = {}) {
    if (this.closing) throw refuse(messages.rebuildsStopping);
    if (!this.craft.state().installed) throw refuse(messages.notInstalled);
    // An update or a change of Craft Anything runs: its files may be switching.
    if (this.craft.job || this.craft.claimed) throw refuse(messages.busy);
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

  begin(input, source, requestId) {
    return beginRebuild(this, input, source, requestId);
  }

  // --- Acting on a rebuild ----------------------------------------------------------

  /**
   * Sends a follow-up request to the rebuild's project (a new round), with staged
   * `pictures` that Craft Anything adds to the project's pictures of the original
   * (reference/). The pictures go whatever happens.
   */
  async followUp(id, request, pictures) {
    try {
      const record = this.require(id);
      const text = cleanRequest(request);
      const ids = cleanPictureIds(pictures);
      return await this.serial(id, async () => {
        this.requireIdle(record);
        const files = this.pictures.take(ids);
        try {
          await this.call(record, "rebuild_start", {
            request: text,
            ...(files.length && { pictures: files }),
          });
        } finally {
          this.pictures.discard(files);
        }
        return this.launched(record);
      });
    } finally {
      this.pictures.release(pictures);
    }
  }

  /** Resumes a paused rebuild (Craft Anything 0.5.0 and 0.6.0 want its request again). */
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
   * 0.5.0 and 0.6.0 still do for a few hundred ms after rebuild_stop answered
   * (verified 2026-11-10).
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
      this.requireListed(record);
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

  /**
   * Removes the rebuild from the list: its record, so its inbox items and pushes end
   * too. Its folder, its AgentPier project and Craft Anything's own records stay.
   * Refused while it runs or starts (Pause first).
   */
  async remove(id) {
    const record = this.require(id);
    return this.serial(id, async () => {
      this.requireListed(record);
      if (record.running) throw refuse(messages.rebuildRunning);
      this.records.delete(id);
      this.unrestored.delete(id);
      this.sampler.forgetApprovals({ id, questions: [] });
      this.persist();
      this.emit({ list: true });
      this.children.settle(record.accountId, record.mode);
    });
  }

  /** Switches auto mode: Craft Anything decides questions, approvals are allowed. */
  async setAutoMode(id, on) {
    const record = this.require(id);
    if (typeof on !== "boolean") throw problem(messages.rebuildAutoModeInvalid, 400);
    return this.serial(id, async () => {
      this.requireListed(record);
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
    this.pictures.stop();
    this.pictures.clear();
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

  /** Refuses (404) a record removed while this action waited in its serial chain. */
  requireListed(record) {
    if (this.records.get(record.id) !== record)
      throw problem(messages.rebuildNotFound, 404);
  }

  require(id) {
    const record = this.records.get(id);
    if (!record) throw problem(messages.rebuildNotFound, 404);
    return record;
  }

  requireIdle(record) {
    this.requireListed(record);
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
