import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { STDIO_CONFIRMATION_REQUIRED } from "../../features/mcp-servers/stdio-confirmation.js";
import { VALUE_REFERENCE } from "../../features/mcp-servers/value-references.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { record } from "../../features/extensions/mcp-config.js";
import { MCP_SERVER_ORIGINS } from "../../features/mcp-servers/server-origins.js";
import { mcpCliRoutes } from "./mcp-cli.js";
import {
  auditDetails,
  changeSource,
  mcpPackageRoutes,
  packagesOf,
  requireInstallConfirmation,
} from "./mcp-packages.js";

/** How a new server was set up (wizard source); anything else counts as manual. */
const createOrigin = (body) =>
  MCP_SERVER_ORIGINS.includes(body?.origin) ? body.origin : "manual";

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
 * Answers a value with an environment or file reference with 400, its stable code,
 * the field and the header or environment names; never the value. Returns false for
 * any other error.
 */
export function replyValueReference(response, error) {
  if (error?.code !== VALUE_REFERENCE) return false;
  response.status(400).json({
    code: error.code,
    field: error.field,
    names: error.names,
    error: error.message,
    ...messageIdentity(error.message),
  });
  return true;
}

/**
 * Validation, conflicts and a busy Gateway keep their reason; a runtime that is not
 * ready and a Gateway reply (whose text can carry private details) stay "unavailable"
 * (503). Anything else is a defect: it is logged once (code, message, stack; never the
 * request) and answered as a generic 500. Package problems keep their status and code
 * (a 502 registry or integrity failure, a 503 toolchain failure).
 */
function routeProblem(error) {
  if (/^MCP_PACKAGE_/.test(error?.code || "")) return error;
  if (Number.isInteger(error?.status) && error.status < 500 && !error.answered)
    return error;
  if (error?.answered || error?.status === 503)
    return assistantProblem("unavailable", 503);
  console.error(
    `AgentPier MCP server route failed (${error?.code || "no code"}): ${error?.stack || error?.message || error}`,
  );
  return problem(serverMessages.http.internalError, 500);
}

export const mcpServerErrors = (error, _req, _res, next) => next(routeProblem(error));

/**
 * The owner's central MCP servers, served with or without agents (agent OAuth logins
 * stay under the assistant routes). Responses carry header and environment names
 * only and URLs without query or fragment; values never leave the store.
 */
export function mcpServerRoutes(services) {
  const { audit } = services;
  // Names and flags only: no header, env, argument, cwd or URL value is recorded.
  // Called once the change is stored (or its install job started): a failing append
  // is logged (action and code only) and never answers a finished change as an error.
  const auditMcp = (action, id, details) => {
    try {
      audit.append({
        action,
        resourceType: "mcp",
        resourceId: id,
        outcome: "success",
        source: "user",
        details,
      });
    } catch (error) {
      console.error(
        `AgentPier could not audit ${action} (${error?.code || error?.message || "no code"}).`,
      );
    }
  };
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
  router.use(mcpPackageRoutes(services, { auditMcp }));
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
    const { confirmStdio, clis, origin: _origin, ...input } = record(body) ? body : {};
    const origin = createOrigin(record(body) ? body : null);
    if (record(body) && body.source !== undefined) {
      // The install confirmation replaces the stdio confirmation for this save.
      requireInstallConfirmation(body);
      const { confirmInstall: _confirm, previewId, program, ...definition } = input;
      let created;
      try {
        created = await packagesOf(services).createServer(definition, {
          previewId,
          program,
          ...(clis === undefined ? {} : { clis }),
        });
      } catch (error) {
        if (replyValueReference(res, error)) return;
        throw error;
      }
      auditMcp("package.installed", created.id, {
        ...auditDetails(body.source),
        origin,
      });
      return res.status(202).json(created);
    }
    let server;
    try {
      server = await changes().create(record(body) ? input : body, {
        confirmStdio: confirmStdio === true,
        ...(clis === undefined ? {} : { clis }),
      });
    } catch (error) {
      if (replyStdioConfirmation(res, error) || replyValueReference(res, error)) return;
      throw error;
    }
    auditMcp("mcp.created", server.id, {
      transport: server.transport,
      stdioConfirmed: server.transport === "stdio" && confirmStdio === true,
      ...(clis === undefined ? {} : { clis }),
      origin,
    });
    res.status(201).json(server);
  });
  // `clis` (optional) replaces the server's coding CLIs in the same write.
  router.put("/mcp-servers/:id", async (req, res) => {
    const body = req.body;
    try {
      if (record(body) && body.source !== undefined)
        return await changeSource(services, { changes, auditMcp }, req, res);
      const { confirmStdio, clis, ...rest } = record(body) ? body : {};
      // A packaged server keeps its generated command; owner args follow the generated ones.
      const input =
        record(body) && services.mcpPackages
          ? services.mcpPackages.prepareUpdate(req.params.id, rest)
          : rest;
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
      if (replyStdioConfirmation(res, error) || replyValueReference(res, error)) return;
      throw error;
    }
  });
  router.delete("/mcp-servers/:id", async (req, res) => {
    const { pending, logoutDeferred, transport } = await changes().remove(req.params.id);
    // A running install of the deleted server stops now: npm or uv end with their
    // whole process tree and the stage goes. Its package record went with the server;
    // installs and toolchains follow in the background (neither call rejects, and the
    // response waits for neither).
    services.mcpPackages?.cancel(req.params.id);
    services.mcpPackages?.prune();
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
