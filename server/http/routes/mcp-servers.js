import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { STDIO_CONFIRMATION_REQUIRED } from "../../features/mcp-servers/stdio-confirmation.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { record } from "../../features/extensions/mcp-config.js";
import { mcpCliRoutes } from "./mcp-cli.js";

/** A saved change whose OAuth logout is retried later (see McpOAuthLogins.forget). */
function deferredWarning() {
  const message = serverMessages.mcpServers.oauthLogoutDeferred;
  return { code: "oauth-logout-deferred", error: message, ...messageIdentity(message) };
}

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
 * Validation, conflicts and a busy Gateway keep their reason; storage and runtime
 * errors can carry private details.
 */
export const mcpServerErrors = (error, _req, _res, next) =>
  next(
    Number.isInteger(error.status) && error.status < 500 && !error.answered
      ? error
      : assistantProblem("unavailable", 503),
  );

/**
 * The owner's central MCP servers, served with or without agents (agent OAuth logins
 * stay under the assistant routes). Responses carry header and environment names
 * only and URLs without query or fragment; values never leave the store.
 */
export function mcpServerRoutes(services) {
  const { audit } = services;
  // Names and flags only: no header, env, argument, cwd or URL value is recorded.
  const auditMcp = (action, id, details) =>
    audit.append({
      action,
      resourceType: "mcp",
      resourceId: id,
      outcome: "success",
      source: "user",
      details,
    });
  const changes = () => {
    if (!services.mcpServerChanges) throw assistantProblem("unavailable", 503);
    return services.mcpServerChanges;
  };
  const router = Router();
  router.use("/mcp-servers", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.use(mcpCliRoutes(services, { auditMcp, replyStdioConfirmation }));
  // OAuth servers carry their agent login status (see McpOAuthLogins.decorate); every
  // server its CLI bindings, their status and its users (CliMcpBindings.decorate).
  router.get("/mcp-servers", async (_req, res) => {
    let list = changes().list();
    if (services.assistantMcpOAuth)
      list = await services.assistantMcpOAuth.decorate(list);
    res.json(services.cliMcp ? await services.cliMcp.decorate(list) : list);
  });
  // `clis` (optional) binds the server to coding CLIs in the same write.
  router.post("/mcp-servers", async (req, res) => {
    const body = req.body;
    const { confirmStdio, clis, ...input } = record(body) ? body : {};
    let server;
    try {
      server = await changes().create(record(body) ? input : body, {
        confirmStdio: confirmStdio === true,
        ...(clis === undefined ? {} : { clis }),
      });
    } catch (error) {
      if (replyStdioConfirmation(res, error)) return;
      throw error;
    }
    auditMcp("mcp.created", server.id, {
      transport: server.transport,
      stdioConfirmed: server.transport === "stdio" && confirmStdio === true,
      ...(clis === undefined ? {} : { clis }),
    });
    res.status(201).json(server);
  });
  // `clis` (optional) replaces the server's coding CLIs in the same write.
  router.put("/mcp-servers/:id", async (req, res) => {
    const body = req.body;
    const { confirmStdio, clis, ...input } = record(body) ? body : {};
    try {
      const { server, pending, logoutDeferred, stdioChanged, cliChange } =
        await changes().update(req.params.id, record(body) ? input : body, {
          confirmStdio: confirmStdio === true,
          ...(clis === undefined ? {} : { clis }),
        });
      // The owner confirmed a local command that changed or now runs in a new CLI.
      const newCli = server.transport === "stdio" && cliChange?.added.length > 0;
      auditMcp("mcp.updated", server.id, {
        transport: server.transport,
        fields: [
          ...Object.keys(record(body) ? input : {}).filter((key) => key !== "revision"),
          ...(cliChange ? ["clis"] : []),
        ],
        ...(cliChange ? { clis: cliChange.clis } : {}),
        stdioConfirmed: (stdioChanged || newCli) && confirmStdio === true,
      });
      res.json({
        ...server,
        ...(pending ? { pending: true } : {}),
        ...(logoutDeferred ? { oauthWarning: deferredWarning() } : {}),
      });
    } catch (error) {
      if (replyStdioConfirmation(res, error)) return;
      throw error;
    }
  });
  router.delete("/mcp-servers/:id", async (req, res) => {
    const { pending, logoutDeferred, transport } = await changes().remove(req.params.id);
    auditMcp("mcp.deleted", req.params.id, { transport });
    if (pending || logoutDeferred)
      res.json({
        ...(pending ? { pending: true } : {}),
        ...(logoutDeferred ? { oauthWarning: deferredWarning() } : {}),
      });
    else res.status(204).end();
  });
  router.use("/mcp-servers", mcpServerErrors);
  return router;
}
