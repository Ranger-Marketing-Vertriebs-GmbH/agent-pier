import { actionTerminal } from "./assistant-action-store.js";
import { notifyAction } from "./assistant-action-notifications.js";
import { personalShell } from "./native-capabilities.js";
import { temporaryMember } from "./team-presentation.js";
import { allowAlwaysPlan } from "./exec-allowlist-policy.js";
import { pairedChannel, telegramOf, telegramTarget } from "./routine-targets.js";

// Exec approval requests from the Gateway become assistant actions awaiting the
// owner (`payload.action: "exec"`), keyed by the Gateway's approval id. A request
// AgentPier cannot attribute to a known agent and conversation is denied at once.
// Events sent while disconnected are lost and a Gateway restart cancels pending
// requests, so every ready reconciles against `exec.approval.list`.
export const execDecisions = ["allow-once", "allow-always", "deny"];
export const execOperationKey = (approvalId) => `exec:${approvalId}`;
const defaultExpiryMs = 30 * 60000;
// `approval.history` statuses, as final action states.
const historyStates = {
  allowed: "completed",
  denied: "declined",
  cancelled: "cancelled",
  expired: "expired",
};
// An approval the Gateway ended stays remembered this long, so a resync whose list
// predates the event cannot import it again.
const tombstoneMs = 10 * 60000;
function execAnalysis(analysis) {
  if (!analysis || typeof analysis !== "object") return {};
  const risks = Array.isArray(analysis.riskKinds)
    ? analysis.riskKinds.filter((r) => typeof r === "string").map((r) => r.slice(0, 60))
    : [];
  return {
    ...(risks.length ? { riskKinds: risks.slice(0, 20) } : {}),
    ...(Number.isSafeInteger(analysis.commandCount)
      ? { commandCount: analysis.commandCount }
      : {}),
  };
}
const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

export class ExecApprovals {
  constructor(
    w,
    {
      log = (line) => console.warn(line),
      now = Date.now,
      retryMs = 1000,
      retries = 5,
    } = {},
  ) {
    Object.assign(this, { w, log, now, retryMs, retries });
    this.ended = new Map();
    // Approval ids whose owner decision is being sent (exec-decisions.js).
    this.deciding = new Set();
    const hub = w.a.gatewayEvents;
    if (!hub) return;
    hub.on("exec.approval.requested", (p) =>
      this.guard("REQUEST", () => this.requested(p)),
    );
    hub.on("exec.approval.resolved", (p) =>
      this.guard("RESOLVE", () => this.resolved(p)),
    );
    hub.onReady(() => this.guard("RESYNC", () => this.resync()));
  }
  get client() {
    return this.w.a.runtime?.client;
  }
  // Never lets a failure reach the event hub; the result is a settled promise.
  guard(phase, operation) {
    return Promise.resolve()
      .then(operation)
      .catch((error) =>
        this.log(
          `Assistant exec approvals: ${phase} failed (${error?.code || error?.status || "ERROR"}).`,
        ),
      );
  }
  // The agent and conversation a request belongs to, or the reason it has none.
  attribute(request) {
    const a = this.w.a,
      agentId = request?.agentId,
      sessionKey = request?.sessionKey;
    const assistant =
      typeof agentId === "string" &&
      a.store.listAssistants().find((p) => p.runtimeAgentId === agentId);
    if (!assistant) return { reason: "UNKNOWN_AGENT" };
    if (personalShell(assistant) === "off") return { reason: "SHELL_OFF" };
    // A routine's run asks in the chat its result goes to, and through the
    // Telegram chat the routine also delivers to, if any.
    const routine = a.routines?.runOrigin(assistant, sessionKey);
    if (routine) {
      const telegram = telegramOf(routine.binding);
      return {
        assistantId: assistant.id,
        conversationId: routine.conversation.id,
        origin: telegram ? { kind: "telegram", ...telegram } : { kind: "owner" },
      };
    }
    // A hook's run asks in the agent's main chat, and in its paired Telegram chat
    // while the hook may also send there (Also send to Telegram). It offers no
    // "Always allow": an event must not make a command permanent for owner turns.
    const hook = a.routines?.hooks?.runOrigin(assistant, sessionKey);
    if (hook) {
      const channel =
        hook.effective.telegram && pairedChannel(a.routines.channels, assistant.id);
      return {
        assistantId: assistant.id,
        conversationId: hook.conversation.id,
        origin: channel
          ? { kind: "telegram", ...telegramTarget(channel) }
          : { kind: "owner" },
        onceOnly: true,
      };
    }
    const conversation =
      typeof sessionKey === "string" &&
      a.store.listConversations().find((c) => c.runtimeSessionKey === sessionKey);
    if (
      !conversation ||
      conversation.archivedAt ||
      conversation.assistantId !== assistant.id
    )
      return { reason: "UNKNOWN_SESSION" };
    // The Telegram target follows the request that started the run, as for other
    // actions. A run AgentPier cannot place asks where the conversation's latest
    // turn came from: the owner's paired Telegram chat, otherwise only the web.
    const attempt = a.ledger?.attemptForRun(request.runId);
    let origin = (!attempt && this.followUpOrigin(assistant, conversation)) || {
        kind: "owner",
      },
      lead = null;
    if (attempt) {
      const req = a.ledger.getRequest(attempt.requestId);
      const context =
        req.conversationId === conversation.id && a.teams?.store.context(req.id);
      // A member's turn for a lead request or team assignment the owner started
      // in Telegram asks there too (`telegram`, see team-coding.js).
      const telegram = context?.kind === "telegram" ? context : context?.telegram;
      if (telegram)
        origin = {
          kind: "telegram",
          channelId: telegram.channelId,
          chatId: telegram.chatId,
          userId: telegram.userId,
        };
      lead = this.lead(context);
    }
    return {
      assistantId: assistant.id,
      conversationId: conversation.id,
      ...(attempt ? { attemptId: attempt.id } : {}),
      // A turn the lead delegated also asks in the lead's chat (workflows.list).
      ...(lead && lead !== assistant.id ? { leadAssistantId: lead } : {}),
      origin,
    };
  }
  /**
   * The Telegram origin of a run AgentPier did not start in a conversation (OpenClaw's
   * own follow-up after a background command, for example), or null. Such a run
   * continues the conversation's latest turn; when that turn came from the owner's
   * paired Telegram chat, its approval is asked there too, as a hook's run asks
   * there. Only while that chat is still the agent's paired, enabled chat writing into
   * this conversation, so a re-paired or another person's chat never receives it.
   */
  followUpOrigin(assistant, conversation) {
    const a = this.w.a,
      channels = this.w.s?.assistantChannels;
    const latest = a.ledger?.latestRequest(conversation.id);
    const context = latest && a.teams?.store.context(latest.id);
    if (context?.kind !== "telegram" || !channels?.store?.list) return null;
    const channel = pairedChannel(channels, assistant.id);
    if (!channel || channel.conversationId !== conversation.id) return null;
    const target = telegramTarget(channel);
    return ["channelId", "chatId", "userId"].every(
      (k) => String(target[k] ?? "") === String(context[k] ?? ""),
    )
      ? { kind: "telegram", ...target }
      : null;
  }
  // The lead that delegated the turn: a lead's request, or a team assignment.
  lead(context) {
    if (context?.kind === "lead-request") return context.leadAssistantId || null;
    if (context?.kind !== "team-member") return null;
    try {
      return this.w.a.teams.store.get(context.teamId).parentAssistantId || null;
    } catch {
      return null;
    }
  }
  payload(id, request, expiresAt, assistant = null) {
    const allowed = Array.isArray(request.allowedDecisions)
      ? execDecisions.filter((d) => request.allowedDecisions.includes(d))
      : execDecisions;
    const payload = {
      action: "exec",
      approvalId: id,
      command: text(request.command, 32768),
      cwd: text(request.cwd, 4096) || null,
      agentId: request.agentId,
      sessionKey: request.sessionKey,
      expiresAt,
      // AgentPier offers allow-always even when OpenClaw withholds it
      // (exec-decisions.js); the allowed decisions tell how to answer it.
      allowedDecisions: allowed,
      ...(request.resolvedPath ? { resolvedPath: text(request.resolvedPath, 4096) } : {}),
      ...(request.warningText ? { warningText: text(request.warningText, 2000) } : {}),
      // OpenClaw's analysis decides how a withheld allow-always is answered
      // (exec-allowlist-policy.js).
      ...execAnalysis(request.commandAnalysis),
    };
    // What "Always allow" will write, decided once now and shown to the owner;
    // the decision writes exactly this plan.
    if (!allowed.includes("allow-always"))
      payload.allowAlwaysPlan =
        // A shortened command no longer says which programs run.
        String(request.command).length > payload.command.length
          ? { kind: "once", reason: "complex" }
          : allowAlwaysPlan(payload, {
              // The agent's exec PATH: its GitHub directories (the managed gh)
              // first, as compiled (agent-github.js), then the owner's.
              pathDirs: [
                ...((assistant && this.w.github?.shellDirs(assistant)) || []),
                ...(this.w.a.runtime?.shell?.pathPrepend || []),
              ],
            });
    return payload;
  }
  async requested(p) {
    const id = text(p?.id, 200);
    if (!id || !p.request || typeof p.request !== "object" || this.isEnded(id)) return;
    const store = this.w.store,
      key = execOperationKey(id);
    let action;
    try {
      if (store.byKey(key)) return;
      const { onceOnly = false, ...owner } = this.attribute(p.request);
      if (owner.reason) return this.deny(id, p.request, owner.reason);
      const expiresAt = Number.isSafeInteger(p.expiresAtMs)
        ? p.expiresAtMs
        : this.now() + defaultExpiryMs;
      // A task member's or a hook run's request offers no "Always allow"
      // (exec-decisions.js).
      const agent = this.w.a.store.getAssistant(owner.assistantId);
      const once = onceOnly || temporaryMember(agent);
      action = store.reserve({
        ...owner,
        payload: {
          ...this.payload(id, p.request, expiresAt, agent),
          ...(once ? { onceOnly: true } : {}),
        },
        key,
        state: "awaiting_approval",
        expiresAt,
      });
    } catch (error) {
      // An action stored under the key makes this a duplicate. Otherwise the
      // request would wait unanswered until the Gateway expires it.
      if (this.stored(key)) return;
      this.log(
        `Assistant exec approval ${id}: intake failed (${error?.code || error?.status || "ERROR"}).`,
      );
      return this.deny(id, p.request, "INTERNAL");
    }
    this.w.a.changed?.();
    // The tick notifies again, so a failed notice leaves the action intact.
    notifyAction(this.w, action, "approval");
  }
  stored(key) {
    try {
      return !!this.w.store.byKey(key);
    } catch {
      return false;
    }
  }
  isEnded(id) {
    const cutoff = this.now() - tombstoneMs;
    for (const [ended, at] of this.ended) if (at < cutoff) this.ended.delete(ended);
    return this.ended.has(id);
  }
  async deny(id, request, reason) {
    // Diagnostics name the request, never the command it carries.
    this.log(
      `Assistant exec approval ${id} denied: ${reason} (agent ${text(request?.agentId, 100) || "-"}).`,
    );
    try {
      await this.client.call("exec.approval.resolve", { id, decision: "deny" });
    } catch (error) {
      // Unanswered, the Gateway falls back to deny when the request expires.
      this.log(`Assistant exec approval ${id}: deny failed (${error?.code || "ERROR"}).`);
    }
  }
  finish(action, state, decision) {
    const current = this.w.store.get(action.id);
    if (actionTerminal.has(current.state)) return;
    this.w.store.patch(action.id, {
      state,
      ...(decision ? { result: { decision } } : {}),
    });
    this.w.a.changed?.();
  }
  async resolved(p) {
    const id = text(p?.id, 200);
    if (!id) return;
    this.ended.set(id, this.now());
    const action = this.w.store.byKey(execOperationKey(id));
    if (!action || actionTerminal.has(action.state) || this.deciding.has(id)) return;
    const decision = execDecisions.includes(p.decision) ? p.decision : null;
    if (decision && decision !== "deny")
      return this.finish(action, "completed", decision);
    // A deny event looks the same for a person, an expiry and a restart; the
    // history tells them apart.
    const record = (await this.history(this.client)).get(id);
    this.finish(
      action,
      historyStates[record?.status] || this.denyState(action, p),
      decision,
    );
  }
  // Without history: a restart resolves as "approval-scope-closed" (verified live),
  // an expiry at or after the expiry time; anything else was declined.
  denyState(action, p) {
    if (p.resolvedBy === "approval-scope-closed") return "cancelled";
    return this.now() >= action.expiresAt ? "expired" : "declined";
  }
  resync(attempt = 0) {
    clearTimeout(this.retryTimer);
    // One pass at a time; a ready during a pass reconciles again afterwards.
    const pass = (this.syncing || Promise.resolve())
      .catch(() => {})
      .then(() => this.reconcile());
    this.syncing = pass;
    // A failed list is retried with backoff while the same client stays ready.
    const client = this.client;
    pass.catch(() => {
      if (this.closed || attempt >= this.retries) return;
      this.retryTimer = setTimeout(
        () => {
          if (this.client === client && client?.ready)
            this.guard("RESYNC", () => this.resync(attempt + 1));
        },
        this.retryMs * 2 ** attempt,
      );
      this.retryTimer.unref?.();
    });
    return pass;
  }
  // Awaiting actions past their expiry ask the Gateway, at most every 10 seconds.
  expired() {
    if (this.now() - (this.expiryCheckAt || 0) < 10000) return;
    this.expiryCheckAt = this.now();
    return this.guard("RESYNC", () => this.resync());
  }
  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
  }
  async reconcile() {
    const client = this.client;
    if (!client?.ready) return;
    const listed = await client.call("exec.approval.list", {});
    const items = (Array.isArray(listed) ? listed : []).filter(
      (i) => i && typeof i.id === "string" && (i.approvalKind ?? "exec") === "exec",
    );
    const live = new Set(items.map((i) => i.id));
    const gone = this.w.store
      .list()
      .filter(
        (a) =>
          a.payload?.action === "exec" &&
          !actionTerminal.has(a.state) &&
          !live.has(a.payload.approvalId) &&
          !this.deciding.has(a.payload.approvalId),
      );
    const history = gone.length ? await this.history(client) : new Map();
    // Each item on its own: one failure must not leave the others unanswered.
    for (const a of gone)
      await this.guard("RESYNC", () => {
        const record = history.get(a.payload.approvalId);
        this.finish(
          a,
          historyStates[record?.status] || "expired",
          execDecisions.includes(record?.decision) ? record.decision : null,
        );
      });
    for (const item of items)
      await this.guard("RESYNC", () => this.unsent(item) || this.requested(item));
  }
  /**
   * A listed request whose action already ended here without being allowed (for
   * example denied locally when shell went off while the Gateway was unreachable):
   * its deny never reached the Gateway, so it is sent now. Returns the send, or
   * null when the item is not such a request.
   */
  unsent(item) {
    const action = this.w.store.byKey(execOperationKey(item.id));
    if (
      !action ||
      !actionTerminal.has(action.state) ||
      action.state === "completed" ||
      this.deciding.has(item.id)
    )
      return null;
    return this.deny(item.id, item.request, "ENDED");
  }
  // How the Gateway ended requests AgentPier missed; empty when unavailable.
  async history(client) {
    try {
      if (!client?.ready) return new Map();
      const result = await client.call("approval.history", {});
      return new Map(
        (Array.isArray(result?.items) ? result.items : []).map((i) => [i?.id, i]),
      );
    } catch {
      return new Map();
    }
  }
}
