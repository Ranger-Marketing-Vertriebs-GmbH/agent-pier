import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { serverMessages } from "../../lib/i18n/de.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { oauthCallbackPath } from "../../features/mcp-servers/oauth-redirect.js";

// The central MCP server list lives on the Accounts page.
const settingsPath = "/accounts";

/** Answers an OAuth refusal or failure with its stable code; false for any other error. */
function replyOAuth(res, error) {
  if (typeof error?.code !== "string" || !Number.isInteger(error.status)) return false;
  res.status(error.status).json({
    code: error.code,
    error: error.message,
    ...messageIdentity(error.message),
  });
  return true;
}

const handle = (work) => async (req, res, next) => {
  try {
    await work(req, res);
  } catch (error) {
    if (!replyOAuth(res, error)) next(error);
  }
};

/**
 * Each login registers a client and starts the OpenClaw CLI. One shared owner
 * budget covers every login and proxy address without trusting forwarded IPs.
 * Build it when the app starts, not while answering a request.
 */
export function mcpOAuthRateLimit() {
  return rateLimit({
    windowMs: 60_000,
    limit: 30,
    keyGenerator: () => "owner",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      const message = serverMessages.mcpServers.oauthRateLimited;
      res
        .status(429)
        .set("Cache-Control", "no-store")
        .json({
          code: "oauth-rate-limited",
          error: message,
          ...messageIdentity(message),
        });
    },
  });
}
/**
 * Owner routes, behind the login: start and end an OAuth login. The browser's
 * origin (checked by the security layer for every POST) decides whether it can
 * reach the compiled redirect.
 */
export function mcpOAuthRoutes({
  assistantMcpOAuth: oauth,
  mcpOAuthLimit: limited = mcpOAuthRateLimit(),
}) {
  const router = Router();
  router.post(
    "/mcp-servers/:id/oauth/login",
    limited,
    handle(async (req, res) => {
      const started = await oauth.start(req.params.id, {
        requestOrigin: req.headers.origin,
      });
      res.json(
        started.connected
          ? { status: "connected" }
          : { status: "authorize", authorizationUrl: started.authorizationUrl },
      );
    }),
  );
  router.post(
    "/mcp-servers/:id/oauth/logout",
    limited,
    handle(async (req, res) => {
      await oauth.logout(req.params.id);
      res.status(204).end();
    }),
  );
  return router;
}

const one = (value) => (typeof value === "string" ? value : undefined);

/**
 * The provider's redirect back to AgentPier. It is mounted before the login check:
 * the provider's top-level navigation carries no session cookie (SameSite=Strict),
 * and the redirect host (127.0.0.1) may differ from the one the owner uses. The
 * unguessable, single-use `state` of a login the owner started (10 minutes) is the
 * authentication. It always answers 303 to the Accounts page with only the result,
 * the server of a valid state, and a stable reason; an unknown, expired, used or
 * replaced state (pending logins are lost on restart) gets `state-invalid`.
 *
 * - Plain network hosts never serve it: no redirect is compiled for them, so only a
 *   leaked state could arrive there.
 * - HEAD is refused, so only the navigation consumes a state.
 * - It holds a mutation lease like every other write; while a backup or restore
 *   holds the barrier exclusively it answers "unavailable" and consumes nothing.
 * - Every completion is audited with the server and the result only.
 */
export function mcpOAuthCallbackRoutes(services) {
  const router = Router();
  const route = oauthCallbackPath.replace(/^\/api/, "");
  router.head(route, (_req, res) => res.status(405).set("Allow", "GET").end());
  router.get(route, async (req, res) => {
    res.set("Cache-Control", "no-store");
    // Refusals return to the Accounts page with a stable reason the UI translates;
    // they run nothing and name no server.
    const fail = (reason) =>
      res.redirect(303, `${settingsPath}?oauth=error&reason=${reason}`);
    if (req.trustBranch === "network") return fail("plain-http-remote");
    const oauth = services.assistantMcpOAuth;
    // Without the assistant services no login can be pending.
    if (!oauth) return fail("state-invalid");
    const barrier = services.mutationBarrier;
    if (barrier?.exclusive) return fail("unavailable");
    const complete = () =>
      oauth.complete({
        state: one(req.query.state),
        code: one(req.query.code),
        error: one(req.query.error),
      });
    let done;
    try {
      done = barrier ? await barrier.run(complete) : await complete();
    } catch (error) {
      return fail(error?.code === "state-invalid" ? "state-invalid" : "unavailable");
    }
    audit(services, done);
    const query = new URLSearchParams({ oauth: done.result, server: done.serverId });
    if (done.reason) query.set("reason", done.reason);
    res.redirect(303, `${settingsPath}?${query}`);
  });
  return router;
}

function audit({ audit: log }, done) {
  try {
    log?.append({
      action: done.result === "connected" ? "mcp.completed" : "mcp.failed",
      resourceType: "mcp",
      resourceId: done.serverId,
      source: "user",
      outcome: done.result === "connected" ? "success" : "failure",
      details: done.reason ? { failReason: done.reason.replaceAll("_", "-") } : {},
    });
  } catch {
    // The audit trail must not undo a completed login.
  }
}
