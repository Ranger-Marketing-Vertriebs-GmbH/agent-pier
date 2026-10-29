// The live `account.auth:<id>` topic, owner only like the accounts routes: a CLI
// account's sign-in state, the value GET /api/accounts/:id/auth-status answers.
//
// The state is what the CLI itself answers (`claude auth status --json`, `codex login
// status`, `opencode auth list`; auth-status.js): the CLIs keep their credentials in
// the system keychain or their own stores, so there is no file to watch. The hub
// samples the state every 30 s while a visible tab watches (hidden tabs unsubscribe),
// one CLI run per account for every tab (one instance per account, and
// AccountAuthStatus shares a running probe and caches it for 10 s). What AgentPier
// changes itself is read at once, past that cache: a login session of the account
// that starts or ends (OperationsEvents lists the sessions every 2.5 s) and every
// write of the accounts. The check time alone changes no digest; the state does.
import { after } from "../sessions/live-state-topic.js";

export const ACCOUNT_AUTH_SAMPLE_MS = 30000;
export const ACCOUNT_AUTH_PARAM = /[A-Za-z0-9][A-Za-z0-9_-]{0,99}/;

// The login sessions of `accountId` and their status.
const loginsOf = (sessions, accountId) =>
  (sessions || [])
    .filter((session) => session?.purpose === "login" && session.accountId === accountId)
    .map((session) => `${session.id}:${session.status}`)
    .sort()
    .join("\n");

/** The topic definition for LiveHub#define. */
export function accountAuthTopic(services) {
  return {
    name: "account.auth",
    mode: "state",
    param: ACCOUNT_AUTH_PARAM,
    sampleMs: ACCOUNT_AUTH_SAMPLE_MS,
    authorize: (principal) => principal?.role === "owner",
    scopeKey: () => "owner",
    read: async (_principal, id) => {
      try {
        return await services.accountAuthStatus.get(id);
      } catch (error) {
        // An account removed meanwhile: the route's refusal, not a fault.
        if (error?.status === 404) error.expected = true;
        throw error;
      }
    },
    digest: ({ checkedAt: _checkedAt, ...value }) => value,
    watch: ({ param, invalidate }) => {
      let logins = null;
      const stop = services.operationsEvents?.onSessions?.((sessions) => {
        const next = loginsOf(sessions, param);
        const changed = logins !== null && next !== logins;
        logins = next;
        if (!changed) return;
        services.accountAuthStatus.forget?.(param);
        invalidate();
      });
      return () => stop?.();
    },
  };
}

/**
 * Reads every watched sign-in state again after each write of the accounts (create,
 * rename, key or provider change, removal), past the status cache.
 */
export function followAccountWrites(services, hub) {
  after(services.accounts, "save", () => {
    services.accountAuthStatus.forget?.();
    hub.invalidate("account.auth");
  });
}
