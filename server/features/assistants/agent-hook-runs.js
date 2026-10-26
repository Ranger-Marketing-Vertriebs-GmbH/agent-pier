import { RunSteps } from "./run-steps.js";
import { cronResultText } from "./cron-result-text.js";
import { hookPrompt } from "./agent-hook-prompt.js";
import { effectiveRights, hookEligible, hookTools } from "./agent-hook-rights.js";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { routineTimeoutSeconds } from "./native-routines.js";
import { pairedChannel, telegramTarget } from "./routine-targets.js";
import { agentName } from "./reminder-audience.js";
import { hookReport } from "./agent-hook-reports.js";
import { telegramMessages } from "../assistant-channels/telegram-messages.js";

const prefix = "agentpier-hook:";
// A run's session (`agent:<agent>:cron:<job>`, per run `…:run:<id>`).
export const runSession = /^agent:([^:]+):cron:([^:]+)(?::run:[^:]+)?$/i;
const jobOf = (sessionKey) =>
  runSession.exec(typeof sessionKey === "string" ? sessionKey : "")?.[2].toLowerCase();
// OpenClaw's silent-reply token; an empty reply is just as silent.
const silent = (text) => !text?.trim() || text.trim() === "NO_REPLY";
// A run times out after five minutes; an event unsettled for three times that lost
// its completion (AgentPier or the Gateway restarted).
const staleMs = 15 * 60000;
const sweepFloorMs = 60000;
const unsettled = (event) => ["pending", "running"].includes(event?.status);

/**
 * The runs of hook events: one disabled one-shot cron job per accepted event, forced
 * to run at once in the agent's main chat with only the hook's tools, and removed
 * after its completion webhook (`/hook-complete/<event row id>`). The completion is
 * recorded on the event (reply, the tool steps observed, what was notified) and, with
 * Notify, sent as a push notice and to the paired Telegram chat.
 */
export class HookRuns {
  constructor(hooks) {
    this.hooks = hooks;
    this.assistants = hooks.assistants;
    this.reminders = hooks.reminders;
    // Tool steps of running hook events, from the Gateway's `agent` frames.
    this.steps = new RunSteps();
    // Events whose completion is being handled (a webhook retry may overlap it).
    this.completing = new Set();
    // The next sweep for events still unsettled after a reconcile (an interrupted
    // run whose completion may never come); replaced by each reconcile.
    this.sweep = null;
    this.later = (run, ms) => setTimeout(run, ms).unref();
  }
  /** The clock event times are kept in. */
  now() {
    return this.hooks.events.now();
  }
  get client() {
    return this.assistants.runtime.client;
  }
  /**
   * Creates and forces the event's job; throws when it could not be started (config
   * apply, cron.add or cron.run failed, or OpenClaw refused the run).
   */
  start(admitted, event) {
    return this.assistants.admit(async () => {
      const { events } = this.hooks;
      // Paused, deleted or no longer eligible since the endpoint checked: no run.
      const hook = this.hooks.store.get(admitted.id);
      const agent = this.assistants.store.getAssistant(admitted.assistantId);
      if (!hook?.enabled || !hookEligible(agent))
        throw assistantProblem("unavailable", 503);
      this.assistants.requireReady();
      // Without Secrets the agent's secrets file is gone before the run starts and
      // stays away until its event settles; a file that cannot be withheld fails the
      // start. The apply below then leaves the file out of the agent's instructions.
      if (!effectiveRights(hook.rights, this.hooks.ceiling(agent)).secrets) {
        events.patch(event.id, { secretsWithheld: true });
        await this.hooks.syncSecrets(agent.id);
      }
      // The agent's live tools and shell level are current before its run starts.
      await this.assistants.config.apply(agent.id);
      const ceiling = this.hooks.ceiling(agent);
      const effective = effectiveRights(hook.rights, ceiling);
      const connection = await this.reminders.start();
      const conversation = await this.reminders.openMain(agent.id);
      const result = await this.client.call("cron.add", {
        name: `Hook ${hook.name}`,
        declarationKey: `${prefix}${event.id}`,
        agentId: agent.runtimeAgentId,
        enabled: false,
        deleteAfterRun: false,
        schedule: { kind: "cron", expr: "0 0 1 1 *", tz: "UTC" },
        wakeMode: "now",
        failureAlert: false,
        sessionTarget: "current",
        sessionKey: conversation.runtimeSessionKey,
        payload: {
          kind: "agentTurn",
          message: hookPrompt({
            hook,
            payloadText: events.payload(event.id) ?? "",
            contentType: event.contentType,
            test: event.test === true,
          }),
          timeoutSeconds: routineTimeoutSeconds,
          lightContext: false,
          toolsAllow: hookTools(effective, ceiling),
        },
        // Announce is the commit into the main chat; the webhook hands the result here.
        delivery: {
          mode: "announce",
          completionDestination: {
            mode: "webhook",
            to: `${connection.url}/hook-complete/${event.id}`,
          },
        },
      });
      const job = result?.job || result;
      if (!job?.id) throw assistantProblem("unavailable", 503);
      // Running before the run starts: its completion may come back at once.
      events.patch(event.id, {
        status: "running",
        jobId: job.id,
        conversationId: conversation.id,
        startedAt: Date.now(),
      });
      let ran;
      try {
        ran = await this.client.call("cron.run", { id: job.id, mode: "force" });
      } catch (error) {
        await this.removeJob(job.id);
        throw error;
      }
      // A refused run is a failed start: the sender's retry must run.
      if (ran?.ran === false) {
        await this.removeJob(job.id);
        throw assistantProblem("unavailable", 503);
      }
      // A completion that never comes is settled by the sweep.
      if (!this.sweep) this.schedule();
      return events.get(event.id);
    });
  }
  removeJob(id) {
    return Promise.resolve()
      .then(() => this.client.call("cron.remove", { id }))
      .catch(() => {});
  }
  /** The completion webhook of an event's job. */
  async complete(id, completion) {
    const event = this.hooks.events.get(id);
    if (!event) return;
    if (
      !completion ||
      !event.jobId ||
      completion.jobId !== event.jobId ||
      !Number.isSafeInteger(completion.runAtMs) ||
      completion.runAtMs < 0 ||
      !["ok", "error"].includes(completion.status)
    )
      throw assistantProblem("invalid", 403);
    // A replay of a settled event, or one arriving while the first is handled,
    // changes nothing.
    if (event.status !== "running" || this.completing.has(id)) return;
    this.completing.add(id);
    try {
      await this.settle(event, completion);
    } finally {
      this.completing.delete(id);
    }
  }
  /** Records the run's result on its event, notifies and removes its job. */
  async settle(event, completion) {
    const { events, store } = this.hooks;
    let agent;
    try {
      agent = this.assistants.store.getAssistant(event.assistantId);
    } catch {
      // The agent is gone: nothing to tell anyone, but the event and job settle.
      this.fail(event);
      return this.removeJob(event.jobId);
    }
    const ok = completion.status === "ok";
    const summary = typeof completion.summary === "string" ? completion.summary : "";
    if (ok) textValue(summary, 65536, true);
    const text = ok
      ? await cronResultText({
          client: this.client,
          agentId: agent.runtimeAgentId,
          event: { ...completion, summary },
        })
      : null;
    // The hook deleted meanwhile: its event is a tombstone (HookEvents.forget) and
    // settles as it is, without a result or notice.
    if (events.get(event.id)?.status !== "running") return this.removeJob(event.jobId);
    const hook = store.get(event.hookId);
    const quiet = ok && silent(text);
    // What the hook may do now: paused or lost rights since it started notify nobody.
    const effective =
      hook?.enabled && hookEligible(agent)
        ? effectiveRights(hook.rights, this.hooks.ceiling(agent))
        : { notify: false, telegram: false };
    const conversation =
      this.reminders.mainConversation(agent.id) ||
      (event.conversationId && { id: event.conversationId });
    if (conversation && !quiet)
      this.reminders.results.record({
        id: `${completion.jobId}:${completion.runAtMs}`,
        conversationId: conversation.id,
        bindingId: event.hookId,
        kind: "hook",
        name: hook?.name || "",
        runAtMs: completion.runAtMs,
        at: Date.now(),
        status: ok ? "ok" : "error",
        ...(ok && {
          text: text.trim(),
          committed: completion.deliveryStatus === "delivered",
        }),
      });
    const notify = effective.notify && !quiet && !!conversation;
    const telegram =
      notify &&
      effective.telegram &&
      this.toTelegram(agent, event, hook, ok && text, conversation.id);
    events.patch(event.id, {
      status: ok ? "done" : "failed",
      ...(quiet && { silent: true }),
      reply: ok && !quiet ? text.trim() : null,
      activity: this.activity(event),
      notified: { push: notify, telegram },
      completedAt: Date.now(),
    });
    this.hooks.releaseSecrets(event.assistantId);
    if (hook && !quiet && !event.test) this.report(hook, event, ok, text);
    if (notify)
      Promise.resolve()
        .then(() =>
          this.hooks.notifications?.notify({
            kind: "agent-routine",
            assistantId: agent.id,
            conversationId: conversation.id,
            eventId: `hook-${event.id}`,
            label: agentName(this.assistants, agent.id),
            ...(telegram ? { telegram: true } : {}),
          }),
        )
        .catch(() => {});
    await this.removeJob(event.jobId);
    this.assistants.changed({ conversationId: conversation?.id });
  }
  /** A permanent member's result reaches its lead (agent-hook-reports.js). */
  report(hook, event, ok, text) {
    try {
      const teams = this.assistants.teams;
      if (
        hookReport(
          { teams: teams?.store, assistants: this.assistants, hooks: this.hooks },
          hook,
          { ...event, status: ok ? "done" : "failed" },
          text,
        )
      ) {
        this.assistants.changed();
        teams.requests?.advance().catch(() => {});
      }
    } catch (error) {
      console.error("Hook report to the lead failed:", error?.message);
    }
  }
  /** The reply, or a failure line, to the owner's paired chat; whether it was queued. */
  toTelegram(agent, event, hook, text, conversationId) {
    const channel = pairedChannel(this.hooks.routines.channels, agent.id);
    if (!channel) return false;
    try {
      this.hooks.routines.channels.outbox.enqueue({
        key: `hook:${event.id}`,
        kind: "hook",
        source: {
          assistantId: agent.id,
          ...telegramTarget(channel),
          hookEventId: event.id,
        },
        text: text ? text.trim() : telegramMessages(channel).hooks.failed(hook.name),
        // Only the failure line is AgentPier wording; it links to the chat's events.
        localized: !text,
        ...(text
          ? {}
          : {
              path: `/agents/${encodeURIComponent(agent.id)}/chats/${encodeURIComponent(conversationId)}`,
            }),
      });
      return true;
    } catch (error) {
      console.error("Hook result to Telegram failed:", error?.message);
      return false;
    }
  }
  /** The observed tool steps of the event's run (never arguments), then forgotten. */
  activity(event) {
    const job = event.jobId.toLowerCase();
    const runs = this.steps.list().filter(([, sessionKey]) => jobOf(sessionKey) === job);
    const steps = runs.flatMap(([runId]) =>
      this.steps
        .view(runId)
        .steps.filter((step) => step.kind === "tool")
        .map(({ tool, state, label }) => ({ tool, state, label })),
    );
    for (const [runId] of runs) this.steps.end(runId);
    return steps;
  }
  /** A Gateway `agent` frame: tool steps of running hook events only. */
  observe(payload) {
    if (payload?.stream !== "item") return;
    const job = jobOf(payload.sessionKey);
    if (!job) return;
    // An indexed lookup; any other cron session (routines) ends here.
    const event = this.hooks.events.byJob(job);
    if (event?.status !== "running") return;
    let agent;
    try {
      agent = this.assistants.store.getAssistant(event.assistantId);
    } catch {
      return;
    }
    if (
      runSession.exec(payload.sessionKey)[1].toLowerCase() !==
      agent?.runtimeAgentId?.toLowerCase()
    )
      return;
    if (event.sessionKey !== payload.sessionKey)
      this.hooks.events.patch(event.id, { sessionKey: payload.sessionKey });
    this.steps.observe({ event: "agent", payload });
  }
  /**
   * On every Gateway ready: events whose completion was lost are failed, and hook jobs
   * of missing or settled events are removed unless they still run.
   */
  reconcile() {
    return this.assistants.admit(async () => {
      if (!this.client?.ready) return;
      const { events } = this.hooks;
      const jobs = (await this.reminders.jobs(null)).filter((job) =>
        job.declarationKey?.startsWith(prefix),
      );
      const running = (job) => Number.isFinite(job.state?.runningAtMs);
      const live = new Set(
        jobs.filter(running).map((job) => job.declarationKey.slice(prefix.length)),
      );
      let changed = false;
      for (const event of events.unsettled()) {
        if (this.now() - event.receivedAt < staleMs || live.has(event.id)) continue;
        this.fail(event);
        changed = true;
      }
      for (const job of jobs) {
        if (
          running(job) ||
          unsettled(events.get(job.declarationKey.slice(prefix.length)))
        )
          continue;
        await this.removeJob(job.id);
      }
      // Tombstones of deleted hooks age out here (live hooks prune on admit).
      events.expire();
      if (changed) this.assistants.changed();
      this.schedule();
    });
  }
  /**
   * Sweeps again once the oldest event still unsettled can be stale: a run that a
   * restart interrupted is younger than the window at the ready that follows it. At
   * most once a minute: a job the Gateway still reports running is not stale.
   */
  schedule() {
    clearTimeout(this.sweep);
    this.sweep = null;
    const oldest = this.hooks.events.unsettled()[0];
    if (!oldest) return;
    const wait = Math.max(sweepFloorMs, oldest.receivedAt + staleMs - this.now() + 1000);
    this.sweep = this.later(() => {
      this.sweep = null;
      this.reconcile().catch(() => {});
    }, wait);
  }
  close() {
    clearTimeout(this.sweep);
    this.sweep = null;
  }
  /** Settles an event whose completion never came; its observed steps are kept. */
  fail(event) {
    this.hooks.events.patch(event.id, {
      status: "failed",
      completedAt: Date.now(),
      activity: event.jobId ? this.activity(event) : [],
    });
    this.hooks.releaseSecrets(event.assistantId);
  }
  /** A deleted hook: the jobs of its unsettled events (read before they are forgotten). */
  async cancel(hookId) {
    const jobs = this.hooks.events
      .unsettled()
      .filter((event) => event.hookId === hookId && event.jobId)
      .map((event) => event.jobId);
    return Promise.all(jobs.map((id) => this.removeJob(id)));
  }
}
