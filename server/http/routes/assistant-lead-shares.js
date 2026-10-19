import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { isTaskGrantId } from "../../features/assistants/task-member-grants.js";
import { assistantErrors } from "./assistant-workflows.js";

const id = (value) => typeof value === "string" && value.length <= 100;

// What leads share with their permanent members (lead-shares.js) and grant their
// task members (`memberGrants`, task-member-grants.js): listed for the member's
// settings, a project's Agents section and the MCP overview; the owner removes any
// one. Task member grants have ids starting with "task:".
export function assistantLeadShareRoutes({ assistants }) {
  const router = Router();
  const shares = () => {
    if (!assistants.workflows?.shares) throw assistantProblem("unavailable", 503);
    return assistants.workflows.shares;
  };
  router.get("/assistant-lead-shares", (req, res) => {
    const { memberId, leadId, projectId, serverId } = req.query;
    for (const value of [memberId, leadId, projectId, serverId])
      if (value !== undefined && !id(value)) throw assistantProblem("invalid");
    res.set("Cache-Control", "no-store");
    const keep = (row) =>
      (!memberId || row.memberAssistantId === memberId) &&
      (!leadId || row.leadId === leadId) &&
      (!projectId || row.projectId === projectId) &&
      (!serverId || row.serverId === serverId);
    res.json({
      shares: shares().list(keep),
      memberGrants: assistants.workflows.memberGrants?.list(keep) || [],
    });
  });
  router.delete("/assistant-lead-shares/:shareId", (req, res) =>
    assistants.admit(async () => {
      if (isTaskGrantId(req.params.shareId)) {
        shares();
        const result = assistants.workflows.memberGrants.revoke(req.params.shareId);
        // The member's bindings changed with its record (TeamMcpBindings.sync); the
        // running Gateway follows like any binding change.
        const pending =
          result.kind === "mcp" && assistants.mcp
            ? await assistants.mcp.applySaved()
            : false;
        return res.json({ ...result, pending });
      }
      const row = shares().find(req.params.shareId);
      const result = shares().remove(req.params.shareId);
      // A server share leaves the running Gateway like any binding change.
      const pending =
        row?.kind === "mcp" && assistants.mcp ? await assistants.mcp.applySaved() : false;
      res.json({ ...result, pending });
    }),
  );
  router.use(assistantErrors);
  return router;
}
