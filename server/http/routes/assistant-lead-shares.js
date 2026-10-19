import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { assistantErrors } from "./assistant-workflows.js";

const id = (value) => typeof value === "string" && value.length <= 100;

// What leads share with their permanent members (lead-shares.js): listed for the
// member's settings, a project's Agents section and the MCP overview; the owner
// removes any one.
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
    res.json({
      shares: shares().list(
        (row) =>
          (!memberId || row.memberAssistantId === memberId) &&
          (!leadId || row.leadId === leadId) &&
          (!projectId || row.projectId === projectId) &&
          (!serverId || row.serverId === serverId),
      ),
    });
  });
  router.delete("/assistant-lead-shares/:shareId", (req, res) =>
    assistants.admit(async () => {
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
