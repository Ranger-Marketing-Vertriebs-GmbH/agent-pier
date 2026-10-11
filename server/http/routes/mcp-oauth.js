import { Router } from "express";
import { serverMessages } from "../../lib/i18n/de.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { oauthCallbackPath } from "../../features/mcp-servers/oauth-redirect.js";

const settingsPath = "/settings/mcp";

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
 * Owner routes, behind the login: start and end an OAuth login. The browser's
 * origin (checked by the security layer for every POST) decides whether it can
 * reach the compiled redirect.
 */
export function mcpOAuthRoutes({ assistantMcpOAuth: oauth }) {
  const router = Router();
  router.post(
    "/mcp-servers/:id/oauth/login",
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
 * authentication. The answer reveals only success or a stable error code.
 */
export function mcpOAuthCallbackRoutes(services) {
  const router = Router();
  router.get(oauthCallbackPath.replace(/^\/api/, ""), async (req, res) => {
    res.set("Cache-Control", "no-store");
    const oauth = services.assistantMcpOAuth;
    const invalidState = () => {
      const message = serverMessages.mcpServers.oauthStateInvalid;
      res
        .status(400)
        .json({ code: "state-invalid", error: message, ...messageIdentity(message) });
    };
    // Without the assistant services no login can be pending.
    if (!oauth) return invalidState();
    let done;
    try {
      done = await oauth.complete({
        state: one(req.query.state),
        code: one(req.query.code),
        error: one(req.query.error),
      });
    } catch (error) {
      if (error?.code === "state-invalid") return invalidState();
      return res.redirect(303, `${settingsPath}?oauth=error&reason=unavailable`);
    }
    const query = new URLSearchParams({ oauth: done.result, server: done.serverId });
    if (done.reason) query.set("reason", done.reason);
    res.redirect(303, `${settingsPath}?${query}`);
  });
  return router;
}
