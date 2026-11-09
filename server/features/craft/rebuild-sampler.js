import { logCraftFailure } from "./craft-log.js";
import { freshQuestions, pausedFields, sampledFields } from "./rebuild-view.js";

// Codes of a client that is gone: the exit handler takes care of the rebuilds.
const goneCodes = new Set(["CRAFT_MCP_CLOSED", "CRAFT_MCP_EXITED"]);
// The sampler reads running rebuilds that Craft Anything already knows.
const sampled = (record) => record.running && !!record.craftProject;

/**
 * Samples CraftRebuilds' (`rebuilds`) running builds each `sampleMs` while any runs,
 * and answers their approvals itself in auto mode. Every sample runs in the rebuild's
 * serial chain.
 */
export class RebuildSampler {
  constructor(rebuilds) {
    this.rebuilds = rebuilds;
    this.timer = null;
    // `${rebuild id}\n${question id}` of the approvals allowed (or being allowed).
    this.approving = new Set();
  }

  schedule() {
    const r = this.rebuilds;
    if (this.timer || r.closing) return;
    if (![...r.records.values()].some(sampled)) return;
    this.timer = r.timers.setTimeout(() => {
      this.timer = null;
      this.tick().finally(() => this.schedule());
    }, r.sampleMs);
  }

  stop() {
    if (this.timer) this.rebuilds.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  async tick() {
    const r = this.rebuilds;
    const running = [...r.records.values()].filter(sampled);
    await Promise.all(
      running.map((record) =>
        r
          // A pause queued before this sample stopped the rebuild meanwhile.
          .serial(record.id, () => sampled(record) && this.sample(record))
          .catch((error) => logCraftFailure("read a rebuild", error)),
      ),
    );
  }

  /**
   * Reads one rebuild from its live child (`rebuild_status` + `project_show`) and, in
   * auto mode, allows its open approvals. A rebuild without a child stops running; one
   * still starting (no Craft project yet) is left to its start.
   */
  async sample(record, { approve = true } = {}) {
    const r = this.rebuilds;
    if (!record.craftProject) return;
    const client = r.children.peek(record.accountId, record.mode);
    if (!client) {
      if (record.running) r.update(record, pausedFields(record));
      return;
    }
    const project = record.craftProject;
    try {
      const status = await client.call("rebuild_status", { project });
      const show = await client.call("project_show", { project });
      const asked = [record.step, record.questions, r.now().toISOString()];
      const fields = sampledFields(status, show, ...asked);
      const { questions, running } = fields;
      r.update(record, {
        ...fields,
        ...freshQuestions(questions, running, record.staleQuestions),
      });
      this.forgetApprovals(record);
      if (approve && record.autoMode && (await this.allowApprovals(record, client)))
        await this.sample(record, { approve: false });
    } catch (error) {
      if (!goneCodes.has(error.code)) throw error;
    } finally {
      r.children.settle(record.accountId, record.mode);
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
        logCraftFailure("allow a rebuild's approval", error);
      }
    }
    return answered;
  }
}
