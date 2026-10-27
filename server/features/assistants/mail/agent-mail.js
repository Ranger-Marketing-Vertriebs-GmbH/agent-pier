import { assistantProblem } from "../assistant-validation.js";
import { isUserAgent } from "../../users/user-access.js";
import { userAgentLocked } from "../../users/user-agent-lock.js";
import { mailCatalog } from "./agent-mail-grants.js";
import { mailOrigin } from "./agent-mail-origin.js";
import { mailInput } from "./agent-mail-input.js";
import { MailCursors } from "./agent-mail-cursors.js";
import { readingActions, runReading } from "./agent-mail-reading.js";

// Agent email (agentpier_mail): the bridge hands a call here (team-bridge.js). Every
// action first passes `gate`: no maintenance, an eligible owner agent or permanent
// member that is no user agent and has no Telegram bot for other people, a turn
// class that may use mail (mail/agent-mail-origin.js), and a live grant for an
// account that still exists (AssistantAccess.mailGrant, the only grant read at use).
const statuses = {
  mailNotGranted: 403,
  mailOriginRefused: 403,
  mailAccountUnavailable: 404,
};

export class AgentMail {
  constructor(w) {
    this.w = w;
    this.cursors = new MailCursors(w.a.store.db);
    // The only MailAccountStore.onRemoved binding: removing an account revokes every
    // agent's grant first. A store set later (tests) is bound to `hook` by hand.
    this.hook = (accountId) => this.revokeAccount(accountId);
    if (w.s.mailAccounts) w.s.mailAccounts.onRemoved = this.hook;
  }
  /**
   * The agent's granted accounts that still exist, with level and recipient rules
   * (its AGENTS.md section and the `accounts` action); [] for an agent that cannot
   * hold mail or while the catalog cannot be read. The catalog is read once.
   */
  accounts(assistantId, catalog = mailCatalog(this.w.s)) {
    let grants;
    try {
      grants = this.w.access.stored(assistantId).mailAccesses;
    } catch {
      return [];
    }
    if (!grants.length || !catalog) return [];
    const byId = new Map(catalog.map((a) => [a.id, a]));
    return grants.flatMap(({ accountId }) => {
      const grant = this.w.access.mailGrant(assistantId, accountId, catalog);
      const account = byId.get(accountId);
      if (!grant || !account) return [];
      return [
        {
          accountId,
          name: account.name,
          address: account.address,
          level: grant.level,
          recipients: grant.level === "send" ? [...(grant.recipients ?? [])] : [],
        },
      ];
    });
  }
  /**
   * Who calls (AgentSsh.caller) and, for a hook run, its live Email tick, re-read on
   * every call. A command's completion run never uses mail.
   */
  caller(inv) {
    if (inv.continuation) {
      inv.assertCurrent();
      throw this.problem("mailOriginRefused");
    }
    const caller = this.w.ssh.caller(inv);
    let hookMail = false;
    if (caller.hook) {
      const run = this.w.a.routines?.hooks?.runOrigin(caller.assistant, inv.sessionKey);
      hookMail = run?.event?.id === caller.origin.eventId && run.effective?.mail === true;
    }
    return { ...caller, hookMail };
  }
  classify(caller) {
    let inherited = null;
    // A mail-result follow-up continues the turn of its own card, never another's.
    if (caller.origin?.kind === "mail-result")
      try {
        const action = this.w.store.get(caller.origin.actionId);
        if (
          action.assistantId === caller.assistant.id &&
          action.payload.action === "mail_send"
        )
          inherited = action.payload.originClass;
      } catch {}
    return mailOrigin({
      context: caller.origin,
      routine: caller.routine,
      hook: caller.hook === true,
      hookMail: caller.hookMail,
      inherited,
    }).class;
  }
  problem(key, status = statuses[key] || 403) {
    return assistantProblem(key, status);
  }
  // The routine's result says so even if the model leaves it out.
  refuse(inv, caller, key, status) {
    if (caller.routine) this.w.a.routines?.noteRefusal?.(inv.sessionKey, "mail_refused");
    return this.problem(key, status);
  }
  /** The checks every action passes; `accounts` needs no account of its own. */
  gate(inv, input) {
    if (this.w.a.maintenance) throw assistantProblem("active", 409);
    const caller = this.caller(inv);
    const agent = this.w.access.eligible(caller.assistant.id);
    if (isUserAgent(agent)) throw userAgentLocked();
    if (this.w.s.assistantTelegramSenders?.connected(agent.id))
      throw this.refuse(inv, caller, "mailNotGranted");
    const cls = this.classify(caller);
    if (cls === "refused") throw this.refuse(inv, caller, "mailOriginRefused");
    if (input.action === "accounts") return { caller, cls, agent };
    const catalog = mailCatalog(this.w.s);
    if (!catalog) throw this.refuse(inv, caller, "mailAccountUnavailable", 503);
    const grant = this.w.access.mailGrant(agent.id, input.accountId);
    if (!grant) throw this.refuse(inv, caller, "mailNotGranted");
    const account = catalog.find((a) => a.id === input.accountId);
    if (!account) throw this.refuse(inv, caller, "mailAccountUnavailable");
    return { caller, cls, agent, grant, account };
  }
  invoke(inv, raw) {
    return Promise.resolve().then(() => {
      const input = mailInput(raw);
      if (
        input.action === "accounts" ? Object.keys(input).length !== 1 : !input.accountId
      )
        throw assistantProblem("invalid");
      const gate = this.gate(inv, input);
      if (input.action === "accounts") {
        const catalog = mailCatalog(this.w.s);
        if (!catalog) throw this.refuse(inv, gate.caller, "mailAccountUnavailable", 503);
        const accounts = this.accounts(gate.agent.id, catalog);
        if (!accounts.length) throw this.refuse(inv, gate.caller, "mailNotGranted");
        return { accounts };
      }
      if (readingActions.includes(input.action))
        return runReading(
          { accounts: this.w.s.mailAccounts, cursors: this.cursors },
          gate,
          input,
        );
      // The changing actions follow with their own modules.
      throw assistantProblem("invalid");
    });
  }
  /**
   * MailAccountStore.onRemoved: every agent's grant and new-mail cursor for the
   * account go in one transaction, before the catalog changes.
   */
  revokeAccount(accountId) {
    if (this.closed) return [];
    return this.w.access.revokeMail(accountId, () =>
      this.cursors.removeAccount(accountId),
    );
  }
  close() {
    this.closed = true;
    if (this.w.s.mailAccounts?.onRemoved === this.hook)
      this.w.s.mailAccounts.onRemoved = null;
  }
}
