import { isDeepStrictEqual } from "node:util";
import { actionTerminal } from "./assistant-action-store.js";
import { decideAudited } from "./approval-audit.js";
import { assistantProblem } from "./assistant-validation.js";
import { decideExec } from "./exec-decisions.js";
import { personalEligible, personalShell, shellLevels } from "./native-capabilities.js";

export const SHELL_CONFIRMATION_REQUIRED = "ASSISTANT_SHELL_CONFIRMATION_REQUIRED";
// Retry delays of a failed live apply: doubling from one second to one minute.
const firstRetryMs = 1000;
const lastRetryMs = 60000;

/**
 * The shell level change `patch` makes to `current`, or null when it makes none.
 * Raising the level needs the owner's confirmation of the warning
 * (`confirmShell`), raising it to "full" also `confirmFull`; lowering never does.
 * Refuses before anything is saved: an ineligible agent with 400 (unless it only
 * restates "off"), a missing
 * confirmation with 409 naming the confirmations still `required`.
 */
export function shellChange(current, patch, { confirmShell, confirmFull } = {}) {
  if (!patch || !("shell" in patch)) return null;
  if (!personalEligible(current)) {
    // Restating "off" changes nothing; any other level is refused.
    if (patch.shell === "off") return null;
    throw assistantProblem("invalid");
  }
  const from = personalShell(current),
    to = patch.shell;
  if (from === to) return null;
  const raised = shellLevels.indexOf(to) > shellLevels.indexOf(from);
  if (raised) {
    const required = [
      ...(confirmShell === true ? [] : ["confirmShell"]),
      ...(to === "full" && confirmFull !== true ? ["confirmFull"] : []),
    ];
    if (required.length)
      throw Object.assign(
        assistantProblem(
          required[0] === "confirmShell"
            ? "shellConfirmationRequired"
            : "shellFullConfirmationRequired",
          409,
        ),
        { code: SHELL_CONFIRMATION_REQUIRED, required },
      );
  }
  return { from, to, raised };
}

/**
 * `patch` without the definition fields whose validated value (`changes`) equals
 * the stored one in `current`; capabilities count key by key, a missing stored key
 * as false. `confirmInstructions` and anything not compared stay.
 */
export function withoutUnchanged(patch, changes, current) {
  const same = {
    name: () => changes.name === current.name,
    instructions: () => changes.instructions === current.instructions,
    model: () => isDeepStrictEqual(changes.model, current.model),
    capabilities: () =>
      Object.entries(changes.capabilities).every(
        ([key, value]) => (current.capabilities?.[key] ?? false) === value,
      ),
    shell: () => changes.shell === (current.shell ?? "off"),
  };
  return Object.fromEntries(
    Object.entries(patch).filter(
      ([key]) => !(same[key] && key in changes && same[key]()),
    ),
  );
}

/**
 * Brings the running Gateway to a saved shell level. Exec and process in the
 * global tools.allow and the agent's tools.exec apply hot (docs/assistant-shell-
 * qualification.md (c)), so AssistantConfig.apply patches both at once. An apply
 * that does not finish stays pending: it is retried with backoff while the
 * Gateway is ready and at each ready, and a turn of that agent applies it first.
 */
export class ShellChanges {
  constructor(assistants, { now = Date.now, warn = console.warn } = {}) {
    Object.assign(this, { a: assistants, now, warn });
    // Agent id -> { failures, retryAt } while the Gateway may lag behind the store.
    this.pending = new Map();
  }
  /** The profile flagged `shellPending` while its level is not live yet. */
  decorate(profile) {
    return profile && this.pending.has(profile.id)
      ? { ...profile, shellPending: true }
      : profile;
  }
  /** Any successful apply of the agent (AssistantConfig.onApplied) is live. */
  applied(id) {
    if (this.pending.delete(id)) this.a.changed();
  }
  /**
   * Applies the stored level; returns whether the Gateway still lags behind.
   * `lowered` records whether the pending level is lower than the live one.
   */
  async apply(id, { lowered } = {}) {
    const mark = (state) => {
      const previous = this.pending.get(id);
      this.pending.set(id, {
        lowered: lowered ?? previous?.lowered ?? false,
        failures: 0,
        retryAt: 0,
        ...state,
      });
    };
    if (!this.a.runtime.client?.ready) {
      // The next start compiles the store; until it answers nothing is live.
      // Only the backoff carries over; `lowered` follows the latest change.
      const { failures = 0, retryAt = 0 } = this.pending.get(id) || {};
      mark({ failures, retryAt });
      return true;
    }
    try {
      await this.a.config.apply(id);
      this.pending.delete(id);
      return false;
    } catch (error) {
      // A removed agent has nothing left to apply.
      if (error?.status === 404) {
        this.pending.delete(id);
        return false;
      }
      const failures = (this.pending.get(id)?.failures || 0) + 1;
      mark({
        failures,
        retryAt: this.now() + Math.min(lastRetryMs, firstRetryMs * 2 ** (failures - 1)),
      });
      // One diagnostic per failure streak, with the error code only.
      if (failures === 1)
        this.warn(
          `Assistant shell level could not be applied to the running Gateway (${
            error?.code || error?.key || "ERROR"
          }); retrying.`,
        );
      return true;
    }
  }
  /** Retries pending applies that are due (all of them with `force`, at a ready). */
  retry({ force = false } = {}) {
    if (this.retrying) return this.retrying;
    const a = this.a;
    if (!this.pending.size || !a.runtime.client?.ready || a.closed || a.maintenance)
      return Promise.resolve();
    this.retrying = (async () => {
      for (const [id, state] of [...this.pending]) {
        if (!force && this.now() < state.retryAt) continue;
        if (await this.apply(id).catch(() => true)) {
          // A Gateway that answers again may still run a turn at the higher level.
          if (force && this.pending.get(id)?.lowered) await this.abortTurns(id);
          continue;
        }
        a.changed();
      }
    })().finally(() => {
      this.retrying = null;
    });
    return this.retrying;
  }
  /**
   * Brings a saved level change to the Gateway (`change` from shellChange). Off
   * denies the pending exec requests first. A lowering whose apply fails is tried
   * once more at once; if the Gateway still runs the higher level, the agent's
   * running turns are aborted and its pending requests denied, so nothing keeps
   * running at that level. Off always aborts the running turns. Returns whether
   * the Gateway still lags behind.
   */
  async settle(id, change) {
    let denied = change.to === "off" ? await this.denyPending(id) : 0;
    let pending = await this.apply(id, { lowered: !change.raised });
    let aborted = false;
    if (pending && !change.raised && this.a.runtime.client?.ready) {
      pending = await this.apply(id);
      if (pending) {
        await this.abortTurns(id);
        aborted = true;
        denied += await this.denyPending(id);
      }
    }
    // Off ends the commands a running turn still executes: an abort kills a
    // foreground exec (docs/assistant-shell-qualification.md (h)).
    if (change.to === "off" && !aborted) await this.abortTurns(id);
    this.audit(id, change, { pending, denied });
    return pending;
  }
  /** Aborts the agent's running turns through the Gateway; returns the count. */
  async abortTurns(id) {
    const a = this.a,
      client = a.runtime.client;
    if (!client?.ready) return 0;
    let aborted = 0;
    for (const attempt of a.ledger.pending()) {
      try {
        const request = a.ledger.getRequest(attempt.requestId);
        const conversation = a.store.getConversation(request.conversationId);
        if (conversation.assistantId !== id) continue;
        await client.call("sessions.abort", {
          key: conversation.runtimeSessionKey,
          runId: attempt.runtimeRunId || attempt.id,
        });
        aborted++;
      } catch {
        // Retried at the next ready while the level stays pending.
      }
    }
    if (aborted) a.reconcile?.().catch(() => {});
    return aborted;
  }
  /**
   * Denies the agent's exec requests still awaiting the owner, once its shell is
   * off. Each action ends here even when the Gateway does not take the deny (not
   * ready, or it no longer has the request): it can no longer be allowed, and an
   * unanswered request falls back to deny when it expires. Returns the count.
   */
  async denyPending(id) {
    const w = this.a.workflows;
    if (!w?.store) return 0;
    const open = w.store
      .list(id)
      .filter((a) => a.payload?.action === "exec" && a.state === "awaiting_approval");
    for (const action of open) {
      try {
        await decideAudited(
          w.s?.audit,
          {
            origin: { kind: "owner" },
            actionId: action.id,
            decision: "deny",
            revision: action.revision,
            kind: "exec",
            assistantId: () => id,
          },
          () => decideExec(w, action, "deny"),
        );
      } catch {
        // Ended below.
      }
      const current = w.store.get(action.id);
      w.store.patch(action.id, {
        ...(actionTerminal.has(current.state)
          ? {}
          : { state: "declined", result: { decision: "deny" } }),
        diagnostic: "SHELL_OFF",
      });
    }
    if (open.length) this.a.changed();
    return open.length;
  }
  /** One audit record per level change; never fails the committed change. */
  audit(id, change, { pending, denied }) {
    try {
      this.a.audit?.append({
        action: "assistant.updated",
        resourceType: "assistant",
        resourceId: id,
        source: "user",
        outcome: "success",
        details: {
          kind: "shell",
          shellFrom: change.from,
          shellTo: change.to,
          ...(pending === undefined ? {} : { pending: !!pending }),
          ...(denied ? { count: denied } : {}),
        },
      });
    } catch (error) {
      console.error("Assistant shell audit failed:", error?.message);
    }
  }
}
