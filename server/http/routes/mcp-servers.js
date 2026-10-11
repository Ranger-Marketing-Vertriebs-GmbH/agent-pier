import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { STDIO_CONFIRMATION_REQUIRED } from "../../features/assistants/mcp-changes.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";

const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Answers a stdio server the owner has not confirmed with 409 and a stable code;
 * returns false for any other error.
 */
export function replyStdioConfirmation(response, error) {
  if (error?.code !== STDIO_CONFIRMATION_REQUIRED) return false;
  response.status(409).json({
    code: error.code,
    error: error.message,
    ...messageIdentity(error.message),
  });
  return true;
}

/**
 * The owner's central MCP servers. Responses carry header and environment names
 * only and URLs without query or fragment; values never leave the store.
 */
export function mcpServerRoutes({ assistantMcpChanges: changes }) {
  const router = Router();
  router.use("/mcp-servers", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/mcp-servers", (_req, res) => res.json(changes.list()));
  router.post("/mcp-servers", async (req, res) => {
    const body = req.body;
    const { confirmStdio, ...input } = record(body) ? body : {};
    let server;
    try {
      server = await changes.create(record(body) ? input : body, {
        confirmStdio: confirmStdio === true,
      });
    } catch (error) {
      if (replyStdioConfirmation(res, error)) return;
      throw error;
    }
    res.status(201).json(server);
  });
  router.put("/mcp-servers/:id", async (req, res) => {
    const body = req.body;
    const { confirmStdio, ...input } = record(body) ? body : {};
    try {
      res.json(
        await changes.update(req.params.id, record(body) ? input : body, {
          confirmStdio: confirmStdio === true,
        }),
      );
    } catch (error) {
      if (replyStdioConfirmation(res, error)) return;
      throw error;
    }
  });
  router.delete("/mcp-servers/:id", async (req, res) => {
    await changes.remove(req.params.id);
    res.status(204).end();
  });
  router.use("/mcp-servers", (error, _req, _res, next) =>
    // Validation, conflicts and a busy Gateway keep their reason; storage and
    // runtime errors can carry private details.
    next(
      Number.isInteger(error.status) && error.status < 500 && !error.answered
        ? error
        : assistantProblem("unavailable", 503),
    ),
  );
  return router;
}
