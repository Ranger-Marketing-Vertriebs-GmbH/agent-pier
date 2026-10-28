import { randomUUID } from "node:crypto";
import { actionTerminal } from "../assistant-action-store.js";
import { notifyAction } from "../assistant-action-notifications.js";
import { assistantProblem } from "../assistant-validation.js";
import { ownerTelegram, pairedTelegram } from "../team-coding.js";
import { toolError } from "../tool-errors.js";
import { mailError } from "../../mail/mail-connection.js";
import { composeMessage, recipientsOf } from "../../mail/mail-compose.js";
import { fileSent, saveDraft, trashDraft } from "../../mail/mail-changes.js";
import { loadDraft } from "../../mail/mail-drafts.js";
import { mailCatalog, recipientAllowed } from "./agent-mail-grants.js";
import { mailPermits } from "./agent-mail-origin.js";
import { auditDelete } from "./agent-mail-changes.js";
import {
  bodyDigest,
  contentDigest,
  inputDigest,
  sendInput,
} from "./agent-mail-send-input.js";

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
// Rule sends kept as rows; well above an hour's cap, which counts them with the cards.
const trustedMailRows = 200;
const followUpRetryMs = 300000;
const retryable = new Set([409, 429, 503]);
const settledStates = new Set([...actionTerminal, "unknown"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Mail errors that end a send before the server could accept the message.
const notSent = new Set([
  "MAIL_AUTH_FAILED",
  "MAIL_TLS_FAILED",
  "MAIL_UNREACHABLE",
  "MAIL_PLAINTEXT_REFUSED",
]);
const isMailCode = (code) => typeof code === "string" && code.startsWith("MAIL_");
const isBug = (error) => error instanceof TypeError || error instanceof ReferenceError;

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
  /** One `send` call after AgentMail.gate; returns the brief's results. */
  async send(inv, caller, cls, grant, account, input) {
    const request = sendInput(input);
    if (mailPermits(grant.level, cls, "send", false) === "refuse")
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
    const permit = mailPermits(grant.level, cls, "send", ruled);
    const agentId = caller.assistant.id;
    // Checked before the draft is saved, and again just before the row is written.
    this.limit(inv, caller, permit);
    const from = { name: stored.displayName || "", address: account.address };
    if (!request.draftUid) {
      const saved = await this.accounts.withImap(account.id, (c) =>
        saveDraft(c, { address: account.address, displayName: from.name }, draft.fields),
      );
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
    try {
      inv.assertCurrent();
      const expiresAt = this.now() + (trusted ? 0 : mailApprovalMs);
      const { replyToUid: _uid, replyToFolder: _folder, ...fields } = draft.fields;
      const payload = {
        action: "mail_send",
        accountId: account.id,
        accountName: account.name,
        from,
        ...fields,
        bodySha256: bodyDigest(fields.body),
        inReplyTo: draft.thread?.inReplyTo ?? null,
        references: draft.thread?.references ?? [],
        draftMessageId: draft.messageId ?? `<${randomUUID()}@${domainOf(from)}>`,
        draftUid: draft.draftUid ?? null,
        originClass: cls,
        trusted,
        inputSha256,
        expiresAt,
      };
      payload.contentSha256 = contentDigest(payload);
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
    if (!trusted) {
      notifyAction(this.w, action, "approval");
      this.w.a.changed({ feeds: false });
      return this.follow(inv, action.id);
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
    return this.outcome(this.w.store.get(action.id));
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
  /**
   * Why a card may no longer send, or null: the grant at the send level, the account
   * with the card's sender address, for a rule send every recipient still within the
   * rules, and the card's digests unchanged. `UNAVAILABLE` while the catalog cannot be
   * read.
   */
  stale(a) {
    const p = a.payload;
    const catalog = mailCatalog(this.w.s);
    if (!catalog) return "UNAVAILABLE";
    const account = catalog.find((x) => x.id === p.accountId);
    if (!account) return "ACCOUNT_REMOVED";
    if (account.address.toLowerCase() !== p.from?.address?.toLowerCase())
      return "ACCESS_CHANGED";
    const grant = this.w.access.mailGrant(a.assistantId, p.accountId, catalog);
    if (grant?.level !== "send") return "ACCESS_CHANGED";
    if (
      p.trusted &&
      !recipientsOf(p).every((r) => recipientAllowed(grant.recipients ?? [], r))
    )
      return "ACCESS_CHANGED";
    if (bodyDigest(p.body) !== p.bodySha256 || contentDigest(p) !== p.contentSha256)
      return "ACCESS_CHANGED";
    return null;
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
  /**
   * Sends the row's mail once, to exactly its recipients and without Bcc, then files
   * it (a copy with Bcc in Sent when the account saves sent mail, the draft to Trash).
   */
  async deliver(a, authorizedBy) {
    const p = a.payload;
    const recipients = recipientsOf(p);
    const message = {
      from: p.from,
      to: p.to,
      cc: p.cc,
      bcc: p.bcc,
      subject: p.subject,
      body: p.body,
      messageId: p.draftMessageId,
      inReplyTo: p.inReplyTo,
      references: p.references,
      date: new Date(this.now()),
    };
    let sent;
    let raw;
    try {
      raw = await composeMessage(message, { keepBcc: false });
      sent = await this.accounts.sendRaw(p.accountId, {
        envelope: { from: p.from.address, to: recipients },
        raw,
      });
    } catch (error) {
      const { code } = toolError(error);
      // Only an error before the SMTP session proves nothing went out; a timeout,
      // reset or odd answer later (after DATA) may have delivered it.
      const failed = !raw || !isMailCode(error?.code) || notSent.has(error.code);
      this.audit(a, authorizedBy, recipients.length, failed ? "failed" : "unknown", code);
      return this.finish(a.id, {
        state: failed ? "failed" : "unknown",
        diagnostic: code,
        result: { code },
      });
    }
    let filed = { savedToSent: false, draftTrashed: false };
    try {
      const copy = await composeMessage(message, { keepBcc: true });
      const saveSent = this.accounts.get(p.accountId).saveSent === true;
      filed = await this.accounts.withImap(p.accountId, (client) =>
        fileSent(client, { raw: copy, saveSent, draftUid: p.draftUid }),
      );
    } catch (error) {
      if (isBug(error)) console.error("Agent mail filing failed:", error?.name);
    }
    this.audit(a, authorizedBy, recipients.length, "sent");
    // The sent draft went to Trash, audited like every Trash move.
    if (filed.draftTrashed)
      auditDelete(
        this.w.s,
        { account: { id: p.accountId }, agent: { id: a.assistantId } },
        1,
      );
    const next = this.finish(a.id, {
      state: "completed",
      result: {
        recipients: recipients.length,
        savedToSent: filed.savedToSent,
        ...(sent?.rejected ? { rejected: sent.rejected } : {}),
      },
    });
    if (p.trusted) this.w.store.pruneTrusted(a.assistantId, "mail_send", trustedMailRows);
    return next;
  }
  /** `mail.sent` with `delivery` sent, failed or unknown (outcome failure for both). */
  audit(a, authorizedBy, recipients, delivery, code) {
    try {
      this.w.s.audit?.append({
        action: "mail.sent",
        resourceType: "mail",
        resourceId: a.payload.accountId,
        source: "system",
        outcome: delivery === "sent" ? "success" : "failure",
        details: {
          kind: "message",
          assistantId: a.assistantId,
          actionId: a.id,
          authorizedBy,
          recipients,
          delivery,
          ...(code ? { code } : {}),
        },
      });
    } catch (error) {
      console.error("Agent mail audit failed:", error?.code || "error");
    }
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

const domainOf = (from) => from.address.slice(from.address.lastIndexOf("@") + 1);
