import { AttemptWindows } from "../features/login/attempt-windows.js";
import { auditActor } from "../features/audit/audit-actor.js";

/**
 * Audit rows for the sign-in routes, which sit before the audit middleware of /api:
 * sign-in, failed sign-in, lockout, sign-out and the owner's setup. A row names how the
 * request arrived and, over the plain network, its address; never a username, a
 * password, a token or the setup code. Writing a row never fails the request.
 */
export function loginAudit(audit, { onError = () => {}, now = Date.now } = {}) {
  // Refusals cost the sender nothing, so a lockout is written once a minute per source
  // and twenty times a minute in all; every other row follows a counted attempt.
  const lockouts = new AttemptWindows({ now, limit: 1, limits: { all: 20 } });
  const details = (req, reason) => ({
    branch: req.trustBranch,
    ...(reason ? { reason } : {}),
    ...(req.trustBranch === "network" ? { address: req.socket.remoteAddress } : {}),
  });
  const append = (event) => {
    try {
      audit?.append(event);
    } catch {
      onError();
    }
  };
  // Nobody is signed in on a refused attempt, so these rows name no actor.
  const failed = (req, reason) =>
    append({
      action: "login.failed",
      resourceType: "login",
      source: "system",
      outcome: "failure",
      details: details(req, reason),
    });
  const refused = (req, source, error) => {
    if (error?.code === "LOGIN_CREDENTIALS_INVALID") failed(req, "credentials");
    else if (
      error?.code === "LOGIN_THROTTLED" &&
      lockouts.allowAll([`source:${[source].flat()[0]}`, "all"])
    )
      append({
        action: "login.denied",
        resourceType: "login",
        source: "system",
        outcome: "failure",
        details: details(req, "throttled"),
      });
  };
  return {
    failed,
    /** Runs one sign-in or setup step and records why it was refused. */
    attempt(req, source, run) {
      let result;
      try {
        result = run();
      } catch (error) {
        refused(req, source, error);
        throw error;
      }
      if (typeof result?.then !== "function") return result;
      return result.catch((error) => {
        refused(req, source, error);
        throw error;
      });
    },
    signedIn: (req, principal) =>
      append({
        action: "login.started",
        resourceType: "login",
        source: "user",
        outcome: "success",
        ...auditActor(principal),
        details: details(req),
      }),
    signedOut: (req, principal) =>
      append({
        action: "login.ended",
        resourceType: "login",
        source: "user",
        outcome: "success",
        ...auditActor(principal),
        details: details(req),
      }),
    ownerCreated: (req) =>
      append({
        action: "login.created",
        resourceType: "login",
        source: "user",
        outcome: "success",
        details: details(req),
      }),
  };
}
