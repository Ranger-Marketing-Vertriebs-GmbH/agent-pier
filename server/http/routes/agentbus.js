import { serverMessages } from "../../lib/i18n/de.js";
import { Router } from "express";
import { problem } from "../../lib/storage.js";
export function agentbusRoutes(services) {
  const { agentbus } = services;
  const router = Router();
  router.get("/agentbus", async (_req, res) => res.json(await agentbus.list()));
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
