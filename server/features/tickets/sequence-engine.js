// Works through the per-repo ticket queues of ticket-sequences.json: starts the head
// ticket (a session in its own worktree, or a pipeline run through the run queue),
// finds and watches its pull request, merges it when the item allows it, writes "Done"
// back and moves on. Every step reads the saved item first, so a restart resumes from
// the store; an interrupted start is adopted or parked, never launched twice.
import { createHash } from "node:crypto";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import * as prForge from "./pr-forge.js";
import { prVerdict } from "./pr-status.js";
import { ticketQueueChanged } from "./live-topics.js";
import { resumeStart, startItem } from "./sequence-start.js";
import { isTransient } from "./sequence-reasons.js";
import {
  FORGE_LIMIT_MS,
  IDLE_LIMIT_MS,
  NO_PR_LIMIT_MS,
  findWorker,
  fixStep,
} from "./sequence-fixes.js";

export { PARK_REASONS } from "./sequence-reasons.js";

const refusalReason = (what) => (what === "arm" ? "armRefused" : "mergeRefused");

// GitHub blocks the merge for now (pending checks or reviews, or a branch behind its
// base): the states in which it accepts auto-merge. A mergeable PR is merged directly.
const ARMABLE_STATES = new Set(["BLOCKED", "BEHIND"]);

/**
 * How this pass may merge an open PR without changes requested: "queue" (green counted
 * checks and reviews; a merge queue refuses direct merges), "merge" (mergeable now),
 * "auto" (GitHub blocks it, enforces at least one required check and none has failed)
 * or null (wait). Without a required check GitHub's auto-merge would ignore CI, so
 * AgentPier waits until every check passes and merges directly.
 */
function mergeHow(snapshot, verdict, green) {
  if (snapshot.repo.mergeQueue) return green ? "queue" : null;
  if (verdict.mergeReady) return "merge";
  const enforced = snapshot.checks.some((check) => check.required);
  if (
    snapshot.repo.autoMergeAllowed &&
    enforced &&
    verdict.checks !== "failed" &&
    ARMABLE_STATES.has(snapshot.mergeStateStatus)
  )
    return "auto";
  return null;
}

const copy = serverMessages.tickets;
// GitHub access that is gone or refused (a 403 rate limit is `rateLimited`).
const ACCESS_CODES = new Set([
  "githubRequired",
  "notConnected",
  "unauthorized",
  "forbidden",
]);
const noGithub = () =>
  Object.assign(problem(copy.githubRequired, 409), { code: "githubRequired" });
// Steps one advance may take: start, find the PR, merge, the next ticket's start…
const MAX_STEPS = 12;

export const codeOf = (error) =>
  typeof error?.code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(error.code)
    ? error.code
    : Number.isInteger(error?.status)
      ? `status-${error.status}`
      : "unknown";

export class TicketSequenceEngine {
  constructor({
    store,
    tickets,
    worktrees,
    forge = prForge,
    launch,
    chatDelivery,
    sessions,
    activity = null,
    runQueue,
    pipelines,
    notifications = null,
    live = () => null,
    now = Date.now,
    intervalMs = 60_000,
    initialDelayMs = 5_000,
    onError = (error, step) =>
      console.error(`AgentPier ticket sequence ${step} failed: ${codeOf(error)}`),
  }) {
    Object.assign(this, { store, tickets, worktrees, forge, launch, chatDelivery });
    Object.assign(this, { sessions, activity, runQueue, pipelines, notifications });
    Object.assign(this, { live, now, intervalMs, initialDelayMs, onError });
    this.closed = false;
    this.controller = new AbortController();
    // projectId → { promise, again }: one step loop per queue at a time.
    this.locks = new Map();
    // projectId → owner actions waiting for the lock: a step loop ends at its next step
    // boundary for them, and the action's own steps carry on afterwards.
    this.waiting = new Map();
    this.pass = null;
    this.timer = null;
    this.interval = null;
  }

  hub() {
    return typeof this.live === "function" ? this.live() : this.live;
  }

  /** Starts the timer; the first pass (after `initialDelayMs`) resumes saved queues. */
  start() {
    if (this.closed || this.timer || this.interval || !(this.intervalMs > 0)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.closed) return;
      const tick = () => this.run().catch((error) => this.onError(error, "pass"));
      tick();
      this.interval = setInterval(tick, this.intervalMs);
      this.interval.unref?.();
    }, this.initialDelayMs);
    this.timer.unref?.();
  }

  /** Stops the timer, aborts pending forge reads and waits for running steps. */
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.interval);
    this.timer = this.interval = null;
    this.controller.abort();
    const pending = [this.pass, ...[...this.locks.values()].map((lock) => lock.promise)];
    await Promise.allSettled(pending.filter(Boolean));
  }

  /** One pass over every queue; a pass that is still running is joined, not repeated. */
  run() {
    if (this.closed) return Promise.resolve();
    if (this.pass) return this.pass;
    this.pass = (async () => {
      for (const queue of this.store.queues()) {
        if (this.closed) break;
        await this.advance(queue.projectId);
      }
    })().finally(() => {
      this.pass = null;
    });
    return this.pass;
  }

  /** Schedules steps for one queue; nudges during a running loop coalesce into one more. */
  nudge(projectId) {
    return this.advance(projectId);
  }

  /** A pipeline run changed: nudges the queue whose head waits for it. */
  runChanged(run) {
    if (!run?.id) return;
    for (const queue of this.store.queues())
      if (this.store.head(queue.projectId)?.runId === run.id)
        this.nudge(queue.projectId).catch((error) => this.onError(error, "nudge"));
  }

  advance(projectId) {
    if (this.closed) return Promise.resolve();
    const running = this.locks.get(projectId);
    if (running) {
      running.again = true;
      return running.promise;
    }
    // Registered before the loop starts: a loop that ends without waiting (an owner
    // action is queued) must not leave a finished lock behind.
    const lock = { again: true, promise: null };
    this.locks.set(projectId, lock);
    lock.promise = (async () => {
      try {
        while (lock.again && !this.closed && !this.waiting.get(projectId)) {
          lock.again = false;
          await this.steps(projectId);
        }
      } finally {
        this.release(projectId, lock);
      }
    })();
    return lock.promise;
  }

  /**
   * Runs an owner action (Retry, Mark done, Remove) on one queue while no step of that
   * queue runs, and steps the queue right after it. Resolves with the action's result
   * as soon as the action ends; the steps that follow keep the lock.
   */
  async exclusive(projectId, action) {
    this.waiting.set(projectId, (this.waiting.get(projectId) ?? 0) + 1);
    try {
      for (let held = this.locks.get(projectId); held; held = this.locks.get(projectId))
        await held.promise;
    } finally {
      const left = this.waiting.get(projectId) - 1;
      if (left > 0) this.waiting.set(projectId, left);
      else this.waiting.delete(projectId);
    }
    let settle;
    const outcome = new Promise((resolve) => (settle = resolve));
    const lock = { again: false, promise: null };
    this.locks.set(projectId, lock);
    lock.promise = (async () => {
      try {
        try {
          settle({ value: await action() });
          lock.again = true;
        } catch (error) {
          // A refused action changed nothing; only nudges that came in step the queue.
          settle({ error });
        }
        while (lock.again && !this.closed) {
          lock.again = false;
          await this.steps(projectId);
        }
      } finally {
        this.release(projectId, lock);
      }
    })();
    const { value, error } = await outcome;
    if (error) throw error;
    return value;
  }

  release(projectId, lock) {
    if (this.locks.get(projectId) === lock) this.locks.delete(projectId);
  }

  async steps(projectId) {
    // PRs merged in this loop: a read that still says open never merges twice.
    const merged = new Set();
    for (
      let count = 0;
      count < MAX_STEPS && !this.closed && !this.waiting.get(projectId);
      count += 1
    ) {
      const queue = this.store.queue(projectId);
      const item = this.store.head(projectId);
      if (!queue || !item || item.state === "needs-owner") return;
      let more = false;
      try {
        const ctx = { ...(await this.context(queue, item)), merged };
        more = await this.step(ctx, item);
      } catch (error) {
        this.onError(error, "step");
        return;
      }
      if (!more) return;
    }
  }

  /** The project, its source link and accesses for one step. */
  async context(queue, item) {
    const project = { id: queue.projectId, path: queue.repoPath };
    const { link, github, plane } = await this.tickets.accesses(project);
    const accesses = { github, plane };
    return {
      projectId: queue.projectId,
      project,
      link,
      github,
      access: accesses[item.source] ?? null,
      source: this.tickets.sources[item.source],
    };
  }

  step(ctx, item) {
    if (item.state === "waiting") return startItem(this, ctx, item);
    if (item.state === "running" && item.starting) return resumeStart(this, ctx, item);
    if (item.state === "running") return this.watchRun(ctx, item);
    if (item.state === "awaiting-merge") return this.watchPr(ctx, item);
    return false;
  }

  save(ctx, item, patch) {
    const saved = this.store.patch(ctx.projectId, item.id, patch);
    ticketQueueChanged(this.hub(), ctx.projectId);
    return saved;
  }

  current(ctx, item) {
    return (
      this.store.queue(ctx.projectId)?.items.find((entry) => entry.id === item.id) ?? item
    );
  }

  /** Parks the item (and so the queue) for the owner and sends one push. */
  park(ctx, item, reason) {
    let current = this.current(ctx, item);
    if (current.state === "needs-owner" || current.state === "done") return false;
    if (current.state === "waiting")
      current = this.save(ctx, current, { state: "running" });
    const at = this.now();
    this.save(ctx, current, {
      state: "needs-owner",
      starting: false,
      needsOwner: { reason, at },
    });
    const eventId = createHash("sha256")
      .update(`ticket-seq:${current.id}:${reason}:${at}`)
      .digest("hex")
      .slice(0, 64);
    Promise.resolve()
      .then(() =>
        this.notifications?.notify({
          kind: "ticket-needs-owner",
          eventId,
          projectId: ctx.projectId,
        }),
      )
      .catch((error) => this.onError(error, "notify"));
    return false;
  }

  /** A forge or source read failed: this pass skips the item; the next one tries again. */
  skip(error, step) {
    if (!this.closed) this.onError(error, step);
    return false;
  }

  /**
   * A GitHub read failed: skipped like any blip, but failures for FORGE_LIMIT_MS in a
   * row (counted from the first one) park the queue: with `githubRequired` when the
   * last one was missing or refused access, else with `forgeUnreachable`.
   */
  forgeFailed(ctx, item, error, step) {
    this.skip(error, step);
    if (this.closed) return false;
    const current = this.current(ctx, item);
    const since = current.forgeFailingSince;
    if (!Number.isFinite(since)) {
      this.save(ctx, current, { forgeFailingSince: this.now() });
      return false;
    }
    if (this.now() - since >= FORGE_LIMIT_MS)
      return this.park(
        ctx,
        current,
        ACCESS_CODES.has(error?.code) ? "githubRequired" : "forgeUnreachable",
      );
    return false;
  }

  /** A GitHub read succeeded: the failure clock starts again at the next failure. */
  forgeOk(ctx, item) {
    return Number.isFinite(item.forgeFailingSince)
      ? this.save(ctx, item, { forgeFailingSince: null })
      : item;
  }

  async readTicket(ctx, item) {
    try {
      return { ticket: await ctx.source.get(ctx.access, item.key, this.signal()) };
    } catch (error) {
      if (error?.code === "notFound")
        return { stop: this.park(ctx, item, "ticketUnavailable") };
      return { stop: this.skip(error, "ticket") };
    }
  }

  signal() {
    return { signal: this.controller.signal };
  }

  async readRun(runId) {
    try {
      return await this.pipelines.get(runId);
    } catch (error) {
      if (error?.status === 404) return null;
      throw error;
    }
  }

  // ── running: wait for the pull request ───────────────────────────────────────

  async watchRun(ctx, item) {
    if (!ctx.github) return this.forgeFailed(ctx, item, noGithub(), "watch");
    return item.kind === "session"
      ? this.watchSession(ctx, item)
      : this.watchPipeline(ctx, item);
  }

  async watchSession(ctx, item) {
    let found;
    try {
      found = item.worktree?.branch
        ? await this.forge.findPullRequest(ctx.github, {
            key: item.key,
            branch: item.worktree.branch,
            since: item.startedAt,
            ...this.signal(),
          })
        : null;
    } catch (error) {
      return this.forgeFailed(ctx, item, error, "find-pr");
    }
    item = this.forgeOk(ctx, item);
    if (found) return this.foundPr(ctx, item, found);
    let worker;
    try {
      worker = await findWorker(this, item);
    } catch (error) {
      return this.skip(error, "sessions");
    }
    if (!worker.exists) return this.park(ctx, item, "sessionEnded");
    // A session that stopped, went quiet for IDLE_LIMIT_MS or worked for NO_PR_LIMIT_MS
    // (from its start, or from the Retry that resumed it) without a PR: the owner looks.
    const now = this.now();
    // The idle clock starts again at a Retry, like the six-hour one.
    const idleSince = Math.max(worker.since ?? -Infinity, item.watchSince ?? -Infinity);
    const quiet =
      worker.state === "idle" &&
      Number.isFinite(idleSince) &&
      now - idleSince >= IDLE_LIMIT_MS;
    const since = item.watchSince ?? item.startedAt;
    const late = Number.isFinite(since) && now - since >= NO_PR_LIMIT_MS;
    if (worker.state === "stopped" || quiet || late)
      return this.park(ctx, item, "noPullRequest");
    return false;
  }

  async watchPipeline(ctx, item) {
    let run;
    try {
      run = await this.readRun(item.runId);
    } catch (error) {
      return this.skip(error, "run");
    }
    if (run?.pullRequestUrl) {
      const ref = this.forge.pullRequestByUrl(ctx.github, run.pullRequestUrl);
      if (!ref) return this.park(ctx, item, "noPullRequest");
      return this.foundPr(ctx, item, {
        number: ref.number,
        url: run.pullRequestUrl,
        headRef: "",
      });
    }
    const queued = this.runQueue.find(item.runId);
    if (queued?.state === "failed" || ["failed", "cancelled"].includes(run?.status))
      return this.park(ctx, item, "runFailed");
    // A finished run without a pull request, or a queue item the owner removed.
    if (run?.status === "completed") return this.park(ctx, item, "noPullRequest");
    if (!run && !queued) return this.park(ctx, item, "runFailed");
    return false;
  }

  foundPr(ctx, item, found) {
    this.save(ctx, item, {
      state: "awaiting-merge",
      pr: { number: found.number, url: found.url, headRef: found.headRef },
      armed: null,
    });
    return true;
  }

  // ── awaiting-merge: watch, arm or merge ──────────────────────────────────────

  async watchPr(ctx, item) {
    if (!ctx.github) return this.forgeFailed(ctx, item, noGithub(), "watch");
    let snapshot;
    try {
      snapshot = await this.forge.readPullRequest(
        ctx.github,
        item.pr.number,
        this.signal(),
      );
    } catch (error) {
      return this.forgeFailed(ctx, item, error, "read-pr");
    }
    if (this.closed) return false;
    let saved = item;
    if (!item.pr.headRef && snapshot.headRef)
      saved = this.save(ctx, item, {
        pr: { ...item.pr, headRef: snapshot.headRef, url: item.pr.url || snapshot.url },
      });
    const verdict = prVerdict(snapshot);
    if (verdict.status === "merged") return this.finish(ctx, saved, snapshot);
    if (verdict.status === "closed") return this.park(ctx, saved, "prClosed");
    const fixed = await fixStep(this, ctx, saved, verdict);
    if (fixed.stop || this.closed) return false;
    // Cleared only after the fix step: its fetch of the PR branch counts as a read too.
    saved = this.forgeOk(ctx, fixed.item);
    if (!saved.options.allowMerge) return false;
    try {
      return await this.mergeStep(ctx, saved, snapshot, verdict);
    } catch (error) {
      return this.skip(error, "merge");
    }
  }

  /**
   * Merges the PR when GitHub reports it mergeable now, else arms it (merge queue, or
   * auto-merge while GitHub blocks it) so GitHub merges it once it may. A direct merge
   * happens only when the verdict says ready, and only for the head it saw. Each head is
   * armed at most once: a head found disarmed on GitHub (the owner, or a merge queue
   * that dropped it) is never armed again, and a refusal is never retried on it.
   */
  async mergeStep(ctx, item, snapshot, verdict) {
    const head = snapshot.headSha;
    const armedNow = snapshot.inMergeQueue ? "queue" : snapshot.autoMerge ? "auto" : null;
    if (verdict.changesRequested) {
      if (snapshot.inMergeQueue) await this.forge.dequeue(ctx.github, snapshot);
      if (snapshot.autoMerge) await this.forge.disableAutoMerge(ctx.github, snapshot);
      // AgentPier's own disarm: the head may be armed again once the review allows it.
      if (armedNow || item.armed || item.armedHead)
        this.save(ctx, item, { armed: null, armedHead: null });
      return false;
    }
    if (armedNow) {
      if (item.armed !== armedNow || item.armedHead !== head)
        this.save(ctx, item, { armed: armedNow, armedHead: head });
      return false;
    }
    const green = verdict.checks === "passed" && !verdict.reviewBlocks;
    if (item.armedHead && item.armedHead === head) {
      // Red checks: the fix rounds push a new head, which may be armed once more.
      if (verdict.checks === "failed") return false;
      // A merge queue drops a head whose checks failed; once a re-run turns it green
      // it may be queued again. Auto-merge stays on through red checks on GitHub, so
      // an auto-merge found off was turned off by a person: that is respected.
      if (item.armed !== "queue" || item.rounds?.lastSha !== head)
        return this.park(ctx, item, "mergeDisarmed");
      item = this.save(ctx, item, { armedHead: null, armed: null });
    }
    const how = mergeHow(snapshot, verdict, green);
    if (!how || (how === "merge" && ctx.merged?.has(item.id))) return false;
    const what = how === "merge" ? "merge" : "arm";
    // Auto-merge is armed while checks or reviews are pending; once they pass, a head
    // GitHub refused to arm waits for nothing more and goes to the owner.
    const ready = how === "auto" ? green : true;
    if (item.refused?.headSha === head && item.refused.what === what)
      return ready ? this.park(ctx, item, refusalReason(what)) : false;
    try {
      if (how === "queue") await this.forge.enqueue(ctx.github, snapshot);
      else if (how === "auto") await this.forge.enableAutoMerge(ctx.github, snapshot);
      else await this.forge.mergePullRequest(ctx.github, snapshot);
    } catch (error) {
      if (isTransient(error)) return this.skip(error, "merge");
      this.onError(error, "merge");
      const saved = this.save(ctx, item, {
        refused: { headSha: head, what, code: codeOf(error) },
      });
      return ready ? this.park(ctx, saved, refusalReason(what)) : false;
    }
    if (how !== "merge") {
      this.save(ctx, item, { armed: how, armedHead: head });
      return false;
    }
    ctx.merged?.add(item.id);
    // Read again at once: the merged PR finishes the ticket in this pass.
    return true;
  }

  /** The PR merged: the item is done first, then "Done" is written to the tracker. */
  async finish(ctx, item, snapshot) {
    const prUrl = snapshot.url || item.pr.url;
    const saved = this.save(ctx, item, {
      state: "done",
      doneBy: "merge",
      doneAt: this.now(),
      armed: null,
      writeBack: { state: "pending" },
    });
    let writeBack = { state: "done" };
    try {
      if (!ctx.access || !ctx.source)
        throw Object.assign(new Error(), { code: "notConnected" });
      const ticket = await ctx.source.get(ctx.access, item.key, this.signal());
      await ctx.source.markDone(ctx.access, ticket, {
        prUrl,
        label: ctx.link?.github?.inProgressLabel,
        ...this.signal(),
      });
    } catch (error) {
      this.onError(error, "done");
      writeBack = { state: "failed", code: codeOf(error) };
    }
    try {
      this.save(ctx, saved, { writeBack });
    } catch (error) {
      this.onError(error, "done");
    }
    return true;
  }
}
