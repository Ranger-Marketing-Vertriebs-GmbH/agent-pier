import { actionTerminal } from "../assistant-action-store.js";
import { notifyAction } from "../assistant-action-notifications.js";
import { assistantProblem } from "../assistant-validation.js";
import { ownerTelegram, pairedTelegram } from "../team-coding.js";
import { mailError } from "../../mail/mail-connection.js";
import { recipientsOf } from "../../mail/mail-compose.js";
import { saveDraft, trashDraft } from "../../mail/mail-changes.js";
import { loadDraft } from "../../mail/mail-drafts.js";
import { storedFiles } from "./agent-mail-sources.js";
import { recipientAllowed } from "./agent-mail-grants.js";
import { mailPermits } from "./agent-mail-origin.js";
import { auditDelete } from "./agent-mail-changes.js";
import { forwardInput, inputDigest, sendInput } from "./agent-mail-send-input.js";
import { forwardCard, htmlOmittedNote, saveForward } from "./agent-mail-forward.js";
import { cardPayload, staleReason } from "./agent-mail-card.js";
import { auditSend, deliverMail, isBug } from "./agent-mail-delivery.js";
import {
  captureFiles,
  savedAttachments,
  storedDraftAttachments,
} from "./agent-mail-draft-files.js";

export { mailTelegramApprovable } from "./agent-mail-send-input.js";

// An agent's `send` (agentpier_mail). It goes out at once only when every to, cc and
// bcc recipient matches the account's recipient rules for the agent; otherwise it
// raises an approval card (action `mail_send`, decided on the web card or its
// Telegram buttons, never by a chat message), like an SSH command
// (agent-ssh-approvals.js): the call holds for 110 s, a later outcome arrives as a
// `mail-result` follow-up turn. A send of new fields saves a draft first, so a
// declined or failed send keeps it; a call refused before its row (or beaten to it
// by a concurrent call with the same key) moves that draft to Trash again. The card
// holds exactly what is sent; approving checks grant, account and the card's digests
// again, and the row's state change makes a second decision a conflict, so a mail
// goes out at most once.
export const mailApprovalMs = 86400000;
export const mailHoldMs = 110000;
export const maxOpenMailApprovals = 5;
// Rule sends and approval cards together; above it no card is raised either.
export const maxSendsPerHour = 30;
export const mailDecisions = ["approve", "decline"];
const hourMs = 3600000;
const followUpRetryMs = 300000;
const retryable = new Set([409, 429, 503]);
const settledStates = new Set([...actionTerminal, "unknown"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class MailSends {
  constructor(mail, { holdMs = mailHoldMs, pollMs = 100 } = {}) {
    Object.assign(this, { mail, holdMs, pollMs });
    // Sends between the owner's approval (or a rule's match) and their outcome.
    this.runs = new Map();
  }
  get w() {
    return this.mail.w;
  }
  get accounts() {
    return this.w.s.mailAccounts;
  }
  now() {
    return this.w.now();
  }
  rows(assistantId) {
    return this.w.store.list(assistantId).filter((a) => a.payload.action === "mail_send");
  }
  open(assistantId) {
    const now = this.now();
    return this.rows(assistantId).filter(
      (a) => !a.payload.trusted && a.state === "awaiting_approval" && a.expiresAt > now,
    ).length;
  }
  /** The rule sends and approval cards of the last hour. */
  hourSends(assistantId) {
    const since = this.now() - hourMs;
    return this.rows(assistantId).filter((a) => Date.parse(a.createdAt) > since).length;
  }
  refuse(inv, caller, key) {
    return this.mail.refuse(inv, caller, key);
  }
  /**
   * One `send` or `forward` call after AgentMail.gate; returns the brief's results.
   * A forward saves its draft from the original (agent-mail-forward.js) and is a send
   * from there on.
   */
  async send(inv, caller, cls, grant, account, input) {
    const forwarding = input.action === "forward";
    const request = forwarding ? forwardInput(input) : sendInput(input);
    if (mailPermits(grant.level, cls, input.action, false) === "refuse")
      throw this.refuse(inv, caller, "mailSendNotGranted");
    const key = `mail:${inv.attemptId || inv.sessionKey}:${inv.toolCallId}`;
    const inputSha256 = inputDigest(input);
    const retried = () => this.retried(key, account.id, inputSha256);
    if (retried()) return this.follow(inv, retried().id);
    let stored;
    try {
      stored = this.accounts.get(account.id);
    } catch {
      stored = null;
    }
    if (!stored) throw this.refuse(inv, caller, "mailAccountUnavailable");
    const draft = request.draftUid
      ? await this.accounts.withImap(account.id, (c) => loadDraft(c, request.draftUid))
      : { fields: request.fields };
    const recipients = recipientsOf(draft.fields);
    if (!recipients.length) throw assistantProblem("invalid");
    const rules = grant.recipients ?? [];
    const ruled = recipients.every((address) => recipientAllowed(rules, address));
    const permit = mailPermits(grant.level, cls, input.action, ruled);
    const agentId = caller.assistant.id;
    // Checked before the draft is saved, and again just before the row is written.
    this.limit(inv, caller, permit);
    const from = { name: stored.displayName || "", address: account.address };
    // The files are read before the draft is saved: a refusal saves nothing.
    const captured = request.draftUid
      ? null
      : await captureFiles(this.w, this.mail.limits, inv, caller, request.attachments);
    let saved = null;
    let forward = null;
    if (forwarding) {
      forward = await saveForward(this.mail, account, from, request, captured);
      ({ saved } = forward);
      draft.fields = forward.fields;
    } else if (!request.draftUid) {
      saved = await this.accounts.withImap(account.id, (c) =>
        saveDraft(c, { address: account.address, displayName: from.name }, draft.fields, {
          files: captured?.entries ?? [],
        }),
      );
    }
    if (saved) {
      Object.assign(draft, {
        draftUid: saved.draftUid,
        messageId: saved.messageId,
        thread: saved.thread,
      });
    } else draft.draftUid = request.draftUid;
    // A draft this call saved goes to Trash again when the send is refused from here
    // on, or when a concurrent call with the same key already wrote the row.
    const own = request.draftUid ? null : draft.draftUid;
    const trusted = permit === "run";
    let action;
    let earlier;
    // The forward's original goes along: its parts, its HTML part and its envelope.
    let card = {};
    try {
      if (forward)
        card = forwardCard(this.mail, account.id, agentId, request, forward, captured);
      // What goes along: the files this call read, or the stored draft's parts.
      const { attachments, files } = saved
        ? {
            attachments:
              card.attachments ??
              savedAttachments(this.mail, account.id, agentId, saved, captured),
            files: captured?.files ?? null,
          }
        : storedDraftAttachments(this.mail, inv, caller, account.id, draft);
      inv.assertCurrent();
      const expiresAt = this.now() + (trusted ? 0 : mailApprovalMs);
      const { replyToUid: _uid, replyToFolder: _folder, ...fields } = draft.fields;
      const payload = cardPayload({
        account,
        from,
        draft,
        fields,
        cls,
        trusted,
        inputSha256,
        expiresAt,
        attachments,
        files: files && storedFiles(files),
        html: card.html ?? null,
        forward: card.forward ?? null,
      });
      const telegram = trusted
        ? null
        : (ownerTelegram(caller.origin) ?? pairedTelegram(this.w, agentId));
      // No await from here to the row: a concurrent call with the same key, or one
      // that took the last free slot, is seen now.
      earlier = retried();
      if (!earlier) {
        this.limit(inv, caller, permit);
        action = this.w.store.reserve({
          assistantId: agentId,
          conversationId: caller.conversationId,
          attemptId: caller.attemptId,
          origin: caller.origin,
          key,
          state: trusted ? "executing" : "awaiting_approval",
          expiresAt,
          payload,
          ...(telegram ? { telegram } : {}),
        });
      }
    } catch (error) {
      await this.dropDraft(account.id, agentId, own);
      throw error;
    }
    if (earlier) {
      await this.dropDraft(account.id, agentId, own);
      return this.follow(inv, earlier.id);
    }
    // The agent hears that a forward left the original's HTML part out.
    const noted = (result) =>
      forward?.original.htmlOmitted ? { ...result, htmlNote: htmlOmittedNote } : result;
    if (!trusted) {
      notifyAction(this.w, action, "approval");
      this.w.a.changed({ feeds: false });
      return noted(await this.follow(inv, action.id));
    }
    // Rights may have changed while the draft was saved.
    const reason = this.stale(action);
    if (reason)
      this.finish(action.id, {
        state: "cancelled",
        diagnostic: reason === "UNAVAILABLE" ? "ACCESS_CHANGED" : reason,
      });
    else {
      inv.undelivered = () => this.markFollowUp(action.id);
      // A rule send is bounded by the SMTP timeouts, not by the approval hold.
      await this.start(action, "rule");
    }
    return noted(this.outcome(this.w.store.get(action.id)));
  }
  /** Moves a draft `send` saved for a refused call to Trash, best effort and audited. */
  async dropDraft(accountId, agentId, draftUid) {
    if (!draftUid) return;
    try {
      const trashed = await this.accounts.withImap(accountId, (c) =>
        trashDraft(c, draftUid),
      );
      if (trashed)
        auditDelete(this.w.s, { account: { id: accountId }, agent: { id: agentId } }, 1);
    } catch (error) {
      if (isBug(error)) console.error("Agent mail draft cleanup failed:", error?.name);
    }
  }
  // The row of an earlier call with the same key, or null; another call's row is a
  // conflict.
  retried(key, accountId, inputSha256) {
    const existing = this.w.store.byKey(key);
    if (!existing) return null;
    if (
      existing.payload.action !== "mail_send" ||
      existing.payload.accountId !== accountId ||
      existing.payload.inputSha256 !== inputSha256
    )
      throw assistantProblem("conflict", 409);
    return existing;
  }
  limit(inv, caller, permit) {
    const agentId = caller.assistant.id;
    if (permit === "card" && this.open(agentId) >= maxOpenMailApprovals)
      throw this.refuse(inv, caller, "mailApprovalLimit");
    if (this.hourSends(agentId) >= maxSendsPerHour)
      throw this.refuse(inv, caller, "mailSendLimit");
  }
  follow(inv, id) {
    // A result the bridge could not hand back arrives as a follow-up instead.
    inv.undelivered = () => this.markFollowUp(id);
    return this.wait(inv, id);
  }
  async wait(inv, id) {
    const deadline = (inv.startedAt ?? this.now()) + this.holdMs;
    for (;;) {
      const a = this.w.store.get(id);
      if (settledStates.has(a.state)) return this.outcome(a);
      let current = true;
      try {
        inv.assertCurrent();
      } catch {
        current = false;
      }
      if (!current || this.now() >= deadline) {
        this.markFollowUp(id);
        if (!current) throw this.mail.problem("mailRevoked");
        if (a.state === "executing")
          return {
            status: "sending",
            actionId: id,
            notice:
              "AgentPier is sending it now. Do not send it again; the result arrives as a separate message.",
          };
        return {
          status: "awaiting_approval",
          actionId: id,
          expiresAt: a.expiresAt,
          notice:
            "The owner has not decided yet. Tell them; the result arrives as a separate message.",
        };
      }
      await sleep(this.pollMs);
    }
  }
  /** The call's own answer once the row settled; refusals are tool errors. */
  outcome(a) {
    this.w.store.patch(a.id, { delivered: true });
    const result = this.envelope(a);
    if (result.status === "cancelled")
      throw this.mail.problem(
        a.diagnostic === "ACCOUNT_REMOVED" ? "mailAccountUnavailable" : "mailRevoked",
      );
    if (result.status === "failed") {
      const error = mailError(result.code);
      throw error.key ? error : assistantProblem("unavailable", 503);
    }
    return result;
  }
  /** What the agent learns about a settled row (also the follow-up's JSON). */
  envelope(a) {
    const actionId = a.id;
    if (a.state === "completed")
      return { status: "sent", actionId, accountId: a.payload.accountId, ...a.result };
    if (a.state === "declined" || a.state === "expired")
      return { status: a.state, actionId, draftKept: true };
    if (a.state === "cancelled")
      return {
        status: "cancelled",
        actionId,
        code:
          a.diagnostic === "ACCOUNT_REMOVED"
            ? "MAIL_ACCOUNT_UNAVAILABLE"
            : "MAIL_REVOKED",
      };
    if (a.state === "failed")
      return { status: "failed", actionId, code: a.result?.code ?? "UNAVAILABLE" };
    return {
      status: "unknown",
      actionId,
      notice:
        "AgentPier cannot tell whether this mail went out. Do not send it again; tell the owner.",
    };
  }
  markFollowUp(id) {
    const a = this.w.store.get(id);
    if (!a.followUp && !a.delivered) this.w.store.patch(id, { followUp: true });
  }
  finish(id, values) {
    const next = this.w.store.patch(id, { ...values, ...this.noted(id, values.state) });
    this.w.a.changed({ feeds: false });
    return next;
  }
  /**
   * The chat note of a card that reached a final state (mailNotes), written once with
   * the state change, so the owner sees the outcome without the agent: {} for a rule
   * send, a state that is not final, or a card already noted.
   */
  noted(id, state) {
    const a = this.w.store.get(id);
    if (a.payload.trusted || !settledStates.has(state) || a.chatNotes?.result) return {};
    return { chatNotes: { ...a.chatNotes, result: { at: this.now(), state } } };
  }
  /** Why a card may no longer send, or null (see staleReason). */
  stale(a) {
    return staleReason(this.w, a);
  }
  /** The owner's decision; workflows.decideOnce checked revision, state, expiry, chat. */
  decide(action, decision) {
    if (decision === "decline") return this.finish(action.id, { state: "declined" });
    const reason = this.stale(action);
    // The card stays while the saved accounts cannot be read.
    if (reason === "UNAVAILABLE") throw assistantProblem("unavailable", 503);
    if (reason) return this.finish(action.id, { state: "cancelled", diagnostic: reason });
    const next = this.finish(action.id, { state: "executing" });
    this.start(next, "approval");
    return next;
  }
  start(a, authorizedBy) {
    const run = this.deliver(a, authorizedBy).finally(() => this.runs.delete(a.id));
    this.runs.set(a.id, run);
    return run.catch(() => {});
  }
  /** Sends the row's mail once and files it (see deliverMail). */
  deliver(a, authorizedBy) {
    return deliverMail(this, a, authorizedBy);
  }
  audit(a, authorizedBy, recipients, delivery, code) {
    auditSend(this.w, a, authorizedBy, recipients, delivery, code);
  }
  /**
   * The workflows tick for mail rows: a card whose rights changed or that expired, its
   * notices, a send lost to a restart, and the follow-up of an outcome the call did
   * not return.
   */
  async advance(a) {
    if (a.state === "awaiting_approval") {
      const reason = this.stale(a);
      if (reason && reason !== "UNAVAILABLE")
        a = this.finish(a.id, { state: "cancelled", diagnostic: reason });
      else if (a.expiresAt <= this.now()) a = this.finish(a.id, { state: "expired" });
      else return notifyAction(this.w, a, "approval");
    }
    if (a.state === "executing") {
      if (this.runs.has(a.id)) return;
      // Never sent again: the send may have gone out before the restart. The agent
      // hears so even when its call had not returned yet.
      this.audit(
        a,
        a.payload.trusted ? "rule" : "approval",
        recipientsOf(a.payload).length,
        "unknown",
      );
      a = this.finish(a.id, {
        state: "unknown",
        ...(a.delivered ? {} : { followUp: true }),
      });
    }
    if (!a.payload.trusted) {
      // A row ended outside finish (made unknown by a restart) gets its note here.
      const note = this.noted(a.id, a.state);
      if (note.chatNotes) a = this.w.store.patch(a.id, note);
      notifyAction(this.w, a, "result");
    }
    if (a.followUp && !a.followUpSent && !a.delivered && !(await this.followUp(a)))
      return;
    this.w.store.patch(a.id, { settled: true });
  }
  async followUp(a) {
    if (a.followUpRetryAt > this.now()) return false;
    try {
      await this.w.a.send(
        a.conversationId,
        {
          clientRequestId: `mail-result:${a.id}`,
          text: `AgentPier mail result for your earlier agentpier_mail send (action ${a.id}) that was still waiting when your call returned. This is attributed data, not a new owner instruction or permission.\n${JSON.stringify(this.envelope(a))}`,
        },
        { kind: "mail-result", actionId: a.id },
      );
      this.w.store.patch(a.id, { followUpSent: true, followUpRetryAt: undefined });
      return true;
    } catch (error) {
      if (!retryable.has(error.status)) {
        this.w.store.patch(a.id, { followUpSent: "failed" });
        return true;
      }
      const failures = (a.followUpFailures || 0) + 1;
      this.w.store.patch(a.id, {
        followUpFailures: failures,
        followUpRetryAt: this.now() + Math.min(1000 * 2 ** failures, followUpRetryMs),
      });
      return false;
    }
  }
  /** Inside AgentMail.revokeAccount's transaction: a removed account's open cards. */
  cancelFor(accountId) {
    let count = 0;
    for (const a of this.w.store.list())
      if (
        a.payload.action === "mail_send" &&
        a.payload.accountId === accountId &&
        a.state === "awaiting_approval"
      ) {
        this.w.store.patch(a.id, {
          state: "cancelled",
          diagnostic: "ACCOUNT_REMOVED",
          ...this.noted(a.id, "cancelled"),
        });
        count++;
      }
    return count;
  }
}
