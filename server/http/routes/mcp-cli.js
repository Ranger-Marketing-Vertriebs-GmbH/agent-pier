import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { record } from "../../features/extensions/mcp-config.js";
import { fileProblem } from "../../features/mcp-servers/cli-status.js";
import { mcpCliLoginRoutes } from "./mcp-cli-oauth.js";

/**
 * Central MCP servers in the coding CLIs: the CLIs a server is bound to, the owner's
 * choice for a conflict or a taken name, and entries found in the CLIs. Responses
 * and audit events carry names only, never a header or environment value; a CLI file
 * problem answers 409 with `MCP_CLI_FILE_<REASON>`.
 */
export function mcpCliRoutes(services, { auditMcp, replyStdioConfirmation }) {
  const router = Router();
  const cli = () => {
    if (!services.cliMcp) throw assistantProblem("unavailable", 503);
    return services.cliMcp;
  };
  /** Runs `work`; a stdio confirmation is answered, a file problem made stable. */
  const answer = async (res, work) => {
    try {
      return { result: await work() };
    } catch (error) {
      if (replyStdioConfirmation(res, error)) return null;
      throw fileProblem(error) ?? error;
    }
  };
  router.use(mcpCliLoginRoutes(services, { auditMcp }));
  router.get("/mcp-servers/cli-finds", (_req, res) => res.json(cli().finds()));
  router.post("/mcp-servers/cli-finds/adopt", (req, res) => {
    const body = record(req.body) ? req.body : {};
    const result = cli().adopt({
      keys: body.keys,
      names: body.names,
      all: body.all === true,
    });
    for (const server of result.adopted)
      auditMcp("mcp.created", server.id, {
        transport: server.transport,
        clis: server.clis,
        adopted: true,
      });
    res.json(result);
  });
  router.put("/mcp-servers/:id/clis", async (req, res) => {
    const body = record(req.body) ? req.body : {};
    const done = await answer(res, () =>
      cli().setClis(req.params.id, body.clis, {
        confirmStdio: body.confirmStdio === true,
      }),
    );
    if (!done) return;
    auditMcp("mcp.updated", req.params.id, {
      fields: ["clis"],
      clis: done.result.clis,
      stdioConfirmed: done.result.stdioConfirmed,
    });
    res.json(await cli().server(req.params.id));
  });
  router.post("/mcp-servers/:id/clis/:cli/resolve", async (req, res) => {
    const body = record(req.body) ? req.body : {};
    const done = await answer(res, () =>
      cli().resolve(req.params.id, req.params.cli, body.choice, {
        confirmStdio: body.confirmStdio === true,
      }),
    );
    if (!done) return;
    // Never resolve()'s own confirmation: only what the owner confirmed is audited.
    auditMcp("mcp.updated", req.params.id, {
      fields: ["clis", ...done.result.fields],
      clis: [req.params.cli],
      resolution: body.choice,
      stdioConfirmed: done.result.stdioConfirmed,
    });
    res.json(await cli().server(req.params.id));
  });
  return router;
}
