import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { record } from "../../features/extensions/mcp-config.js";
import { cliOAuthCallbackPath } from "../../features/mcp-servers/oauth-redirect.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { problem } from "../../lib/storage.js";

// The central MCP server list lives on the Accounts page.
const settingsPath = "/accounts";

/** Answers a login refusal or failure with its stable code; false for any other error. */
function replyLogin(res, error) {
  if (typeof error?.code !== "string" || !Number.isInteger(error.status)) return false;
  res.status(error.status).json({
    code: error.code,
    error: error.message,
    ...messageIdentity(error.message),
  });
  return true;
}

/**
 * Owner routes, behind the login: start and cancel a brokered Codex MCP login in an
 * AgentPier-managed Codex account (CodexMcpLogins). The browser's origin (checked by
 * the security layer for every POST and DELETE) decides whether it can reach the
 * callback. Responses carry the provider's authorization URL only, never a token;
 * audit events name the server, the account and the CLI.
 */
export function mcpCliLoginRoutes(services, { auditMcp }) {
  const router = Router();
  const logins = () => {
    if (!services.codexMcpLogins) throw assistantProblem("unavailable", 503);
    return services.codexMcpLogins;
  };
  // Each login starts a Codex process; one owner budget covers every address.
  const limited = rateLimit({
    windowMs: 60_000,
    limit: 30,
    keyGenerator: () => "owner",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      const message = serverMessages.mcpServers.oauthRateLimited;
      res.status(429).json({
        code: "oauth-rate-limited",
        error: message,
        ...messageIdentity(message),
      });
    },
  });
  const accountOf = (req) => {
    const accountId = record(req.body) ? req.body.accountId : undefined;
    if (typeof accountId !== "string" || !accountId)
      throw problem(serverMessages.mcpServers.invalidRequest, 400);
    return accountId;
  };
  const path = "/mcp-servers/:id/cli-oauth/codex/login";
  router.post(path, limited, async (req, res) => {
    const accountId = accountOf(req);
    let started;
    try {
      started = await logins().start(req.params.id, accountId, {
        requestOrigin: req.headers.origin,
      });
    } catch (error) {
      if (replyLogin(res, error)) return;
      throw error;
    }
    auditMcp("mcp.started", req.params.id, { clis: ["codex"], accountId });
    res.json({ authorizationUrl: started.authorizationUrl });
  });
  router.delete(path, (req, res) => {
    const accountId = accountOf(req);
    if (logins().cancel(req.params.id, accountId))
      auditMcp("mcp.cancelled", req.params.id, { clis: ["codex"], accountId });
    res.status(204).end();
  });
  return router;
}

/**
 * The provider's redirect back to a brokered Codex login, at the callback URL plus the
 * path segment Codex appends per server URL. Mounted before the login check like the
 * agent OAuth callback (mcp-oauth.js): the unguessable, single-use `state` of a login
 * the owner started (five minutes) is the authentication, and the login is found by
 * `state`, never by the segment (two accounts share it). The callback goes to the
 * waiting Codex, which exchanges the code and stores the tokens in the account; then
 * the browser returns to the Accounts page with only the result, the server, the
 * account, the CLI and a stable reason. The URL, `code` and `state` are never logged.
 *
 * - Plain network hosts never serve it: Codex was never sent there.
 * - HEAD is refused, so only the navigation consumes a state.
 * - It holds a mutation lease like every other write; while a backup or restore holds
 *   the barrier exclusively it answers "unavailable" and consumes nothing.
 */
export function mcpCliOAuthCallbackRoutes(services) {
  const router = Router();
  const route = `${cliOAuthCallbackPath.replace(/^\/api/, "")}/:segment`;
  router.head(route, (_req, res) => res.status(405).set("Allow", "GET").end());
  router.get(route, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const fail = (reason) =>
      res.redirect(303, `${settingsPath}?oauth=error&reason=${reason}`);
    if (req.trustBranch === "network") return fail("plain-http-remote");
    const logins = services.codexMcpLogins;
    if (!logins) return fail("state-invalid");
    const barrier = services.mutationBarrier;
    if (barrier?.exclusive) return fail("unavailable");
    const complete = () => logins.complete(req.originalUrl);
    let done;
    try {
      done = barrier ? await barrier.run(complete) : await complete();
    } catch {
      return fail("unavailable");
    }
    if (!done.serverId) return fail(done.reason);
    audit(services, done);
    const query = new URLSearchParams({
      oauth: done.result,
      server: done.serverId,
      cli: "codex",
      account: done.accountId,
    });
    if (done.reason) query.set("reason", done.reason);
    res.redirect(303, `${settingsPath}?${query}`);
  });
  return router;
}

function audit({ audit: log }, done) {
  const connected = done.result === "connected";
  try {
    log?.append({
      action: connected ? "mcp.completed" : "mcp.failed",
      resourceType: "mcp",
      resourceId: done.serverId,
      source: "user",
      outcome: connected ? "success" : "failure",
      details: {
        clis: ["codex"],
        accountId: done.accountId,
        ...(done.reason ? { failReason: done.reason.replaceAll("_", "-") } : {}),
      },
    });
  } catch {
    // The audit trail must not undo a completed login.
  }
}
