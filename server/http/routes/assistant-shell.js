import { Router } from "express";
import { SHELL_CONFIRMATION_REQUIRED } from "../../features/assistants/shell-changes.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";

/**
 * Answers a shell level the owner has not confirmed with 409, a stable code and
 * the confirmations still required; returns false for any other error.
 */
export function replyShellConfirmation(response, error) {
  if (error?.code !== SHELL_CONFIRMATION_REQUIRED) return false;
  response.status(409).json({
    code: error.code,
    error: error.message,
    required: error.required,
    ...messageIdentity(error.message),
  });
  return true;
}

/** An agent's exec allowlist in the Gateway: list its entries and delete one. */
export function assistantShellRoutes({ assistants }) {
  const router = Router();
  router.get("/assistants/:id/shell-allowlist", async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await assistants.allowlist.list(req.params.id));
  });
  router.delete("/assistants/:id/shell-allowlist/:entry", async (req, res) =>
    res.json(await assistants.allowlist.remove(req.params.id, req.params.entry)),
  );
  return router;
}
