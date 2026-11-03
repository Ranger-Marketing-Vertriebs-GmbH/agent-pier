import { createHash } from "node:crypto";
import { TicketSourceError } from "./http-json.js";
import { GITHUB_KEY, canonicalKey } from "./ticket-start-input.js";
import { labelKey } from "./ticket.js";

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

/**
 * The poll interval of config.json `"ticketRules": { "intervalMinutes": 10 }`: an
 * integer from 1 to 1440 minutes, else the default of 10. Applies at the next start.
 */
export function ticketRuleTiming(saved) {
  const minutes = saved?.intervalMinutes;
  return {
    intervalMs:
      Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440
        ? minutes * 60_000
        : DEFAULT_INTERVAL_MS,
  };
}

// The failure codes a source read can end in; anything else counts as unavailable.
const SOURCE_CODES = new Set([
  "unauthorized",
  "forbidden",
  "notFound",
  "rateLimited",
  "unavailable",
  "unreachable",
  "invalidResponse",
]);
const sourceCode = (error) =>
  error instanceof TicketSourceError && SOURCE_CODES.has(error.code)
    ? error.code
    : "unavailable";
// The ticket number at the end of a key ("acme/app#12", "AP-12"): oldest first.
const number = (key) => Number(/(\d+)$/.exec(key)?.[1] ?? 0);

/**
 * Polls the label rules of every project and appends each newly labelled ticket to the
 * project's ticket sequence. A pass reads every connected source once per project, for
 * all its rules, and hands the matches to TicketSequenceService.appendFromRule, which
 * dedupes them. A failure is shown on the rule (a code only) and notifies the owner
 * once per error kind until a successful pass clears the kinds already pushed.
 */
export class TicketRuleMonitor {
  constructor({
    rules,
    tickets,
    sequences,
    notifications,
    intervalMs = DEFAULT_INTERVAL_MS,
    initialDelayMs = 30 * 1000,
    now = Date.now,
    onError = () => {},
    log = (line) => console.error(line),
  }) {
    Object.assign(this, {
      rules,
      tickets,
      sequences,
      notifications,
      intervalMs,
      initialDelayMs,
      now,
      onError,
      log,
    });
    this.pending = null;
    this.again = false;
    this.closed = false;
    this.controller = new AbortController();
  }
  get enabled() {
    // A rule file this version cannot use leaves the rules off (rule-store.js).
    return this.intervalMs > 0 && !this.closed && !this.rules.locked;
  }
  start() {
    if (!this.enabled || this.timer) return;
    const tick = () => this.run().catch(this.onError);
    this.timer = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, this.intervalMs);
      this.timer.unref?.();
    }, this.initialDelayMs);
    this.timer.unref?.();
  }
  /** One pass; a call during a pass joins it. */
  run() {
    if (this.closed) return Promise.resolve();
    this.pending ??= this.collect().finally(() => {
      this.pending = null;
      if (this.again) {
        this.again = false;
        this.request();
      }
    });
    return this.pending;
  }
  /** A pass soon: right away, or once more right after the running one. */
  request() {
    if (!this.enabled) return;
    if (this.pending) this.again = true;
    else this.run().catch(this.onError);
  }
  async collect() {
    const byProject = new Map();
    for (const rule of this.rules.allRules()) {
      if (rule.paused) continue;
      if (!byProject.has(rule.projectId)) byProject.set(rule.projectId, []);
      byProject.get(rule.projectId).push(rule);
    }
    for (const [projectId, list] of byProject) {
      if (this.closed) return;
      list.sort((a, b) => a.createdAt - b.createdAt);
      try {
        await this.poll(projectId, list);
      } catch (error) {
        if (!this.closed) this.onError(error);
      }
    }
  }
  async poll(projectId, list) {
    let project;
    try {
      project = this.tickets.resolveProject(projectId);
    } catch {
      for (const rule of list) await this.fail(rule, "projectGone");
      return;
    }
    const { link: _link, ...accesses } = await this.tickets.accesses(project);
    if (this.closed) return;
    const signal = this.controller.signal;
    // Each source a rule needs is read once, without a label, for all its rules.
    const reads = new Map();
    for (const rule of list) {
      if (!accesses.github || !accesses[rule.source] || reads.has(rule.source)) continue;
      reads.set(
        rule.source,
        this.tickets.sources[rule.source].list(accesses[rule.source], { signal }).then(
          ({ tickets, truncated }) => ({ tickets, truncated: truncated === true }),
          (error) => ({ code: sourceCode(error) }),
        ),
      );
    }
    for (const rule of list) {
      if (this.closed) return;
      const access = accesses[rule.source];
      if (!accesses.github || !access) {
        await this.fail(rule, "notConnected");
        continue;
      }
      const read = await reads.get(rule.source);
      if (this.closed) return;
      // Deleted, paused or moved to another label or source while the source was read.
      const current = this.rules.rule(projectId, rule.id);
      if (
        !current ||
        current.paused ||
        current.source !== rule.source ||
        labelKey(current.label) !== labelKey(rule.label)
      )
        continue;
      if (read.code) {
        await this.fail(current, read.code);
        continue;
      }
      await this.check(project, current, access, read);
    }
  }
  /**
   * `read.truncated`: the source has more open tickets than a read takes (300 GitHub
   * issues, 500 Plane work items). The pass still succeeds, flagged `capped`, because
   * labelled tickets beyond the cap were not seen; `labelGone` still comes only from
   * hasLabel, which asks for the label itself.
   */
  async check(project, rule, access, { tickets, truncated }) {
    const label = labelKey(rule.label);
    const matches = tickets
      .filter((ticket) => (ticket.labels ?? []).map(labelKey).includes(label))
      // The spelling manual starts use, since the dedupe compares keys exactly.
      .map((ticket) =>
        rule.source === "github" && GITHUB_KEY.test(ticket.key)
          ? { ...ticket, key: canonicalKey("github", ticket.key, access) }
          : ticket,
      )
      .sort((a, b) => number(a.key) - number(b.key));
    if (!matches.length) {
      let found;
      try {
        found = await this.tickets.sources[rule.source].hasLabel(access, rule.label, {
          signal: this.controller.signal,
        });
      } catch (error) {
        if (!this.closed) await this.fail(rule, sourceCode(error));
        return;
      }
      if (this.closed) return;
      return found ? this.succeed(rule, truncated) : this.fail(rule, "labelGone");
    }
    const { full } = await this.sequences.appendFromRule(project, rule.id, matches, {
      signal: this.controller.signal,
    });
    if (this.closed) return;
    return full ? this.fail(rule, "queueFull") : this.succeed(rule, truncated);
  }
  succeed(rule, capped = false) {
    this.rules.setStatus(rule.projectId, rule.id, {
      checkedAt: this.now(),
      error: null,
      notified: null,
      ...(capped ? { capped: true } : {}),
    });
  }
  async fail(rule, code) {
    const before = this.rules.rule(rule.projectId, rule.id) ?? rule;
    const { status } = before;
    const same = status.error?.code === code;
    const since = same ? status.error.since : this.now();
    if (!same) this.log(`AgentPier could not poll a label rule: ${code}`);
    // Every code pushed since the last successful pass, so codes that alternate (a
    // tracker flipping between 5xx and timeouts) push once each, not on every pass.
    const pushed = status.notified ?? [];
    const next = {
      checkedAt: this.now(),
      error: { code, since },
      notified: pushed,
    };
    if (!pushed.includes(code)) {
      // One notice per rule, error kind and episode.
      const eventId = createHash("sha256")
        .update(`ticket-rule:${rule.id}:${code}:${since}`)
        .digest("hex")
        .slice(0, 64);
      try {
        await this.notifications?.notify({
          kind: "ticket-rule-failed",
          eventId,
          projectId: rule.projectId,
        });
      } catch (error) {
        this.onError(error);
      }
      next.notified = [...pushed, code];
      // An owner edit during the push that deleted, paused or moved the rule reset its
      // status: the old error must not come back over it.
      const after = this.rules.rule(rule.projectId, rule.id);
      if (
        !after ||
        after.paused ||
        after.source !== before.source ||
        labelKey(after.label) !== labelKey(before.label)
      )
        return;
    }
    this.rules.setStatus(rule.projectId, rule.id, next);
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.timer);
    this.controller.abort();
    // An aborted read settles at once; never let shutdown wait on a tracker.
    let timer;
    await Promise.race([
      this.pending?.catch(() => {}),
      new Promise((resolve) => (timer = setTimeout(resolve, 1000))),
    ]);
    clearTimeout(timer);
  }
}
