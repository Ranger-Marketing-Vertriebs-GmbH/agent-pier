import { serverMessages } from "../../lib/i18n/de.js";
import { Router } from "express";
import { problem } from "../../lib/storage.js";
import { wantsRemotes } from "../../features/repositories/git-remote.js";
export function agentbusRoutes(services) {
  const { agentbus, gitRemotes } = services;
  const router = Router();
  router.get("/agentbus", async (req, res) => {
    const listed = await agentbus.list();
    if (gitRemotes && wantsRemotes(req))
      listed.projects = await gitRemotes.annotate(listed.projects, "cwd");
    res.json(listed);
  });
  router.get("/agentbus/projects/:id/messages", async (req, res) => {
    const raw = req.query.page;
    if (
      raw !== undefined &&
      (typeof raw !== "string" ||
        !/^\d+$/.test(raw) ||
        !Number.isSafeInteger(Number(raw)))
    )
      throw problem(serverMessages.http.invalidMessagePage);
    res.json(
      await agentbus.messages(req.params.id, {
        page: raw === undefined ? 1 : Number(raw),
      }),
    );
  });
  return router;
}
