import { Router } from "express";
import { toolInstallations } from "../../features/tools/tool-installation-list.js";

export function toolsRoutes(services) {
  const { installer } = services;
  const router = Router();
  router.post("/tools/:id/update", async (req, res) =>
    res.status(202).json(installer.startUpdate(req.params.id)),
  );
  // `?tool=<id>` answers only that tool's installation (the live job.tool topic).
  router.get("/tool-installations", async (req, res) => {
    const { tool } = req.query;
    res.json(
      await toolInstallations(installer, typeof tool === "string" ? tool : undefined),
    );
  });
  // Only the managed agent browser can be removed here (chromium-installer.js).
  router.delete("/tools/:id", async (req, res) =>
    res.json(await installer.remove(req.params.id)),
  );
  router.post("/tools/:id/install", async (req, res) =>
    res.status(202).json(installer.start(req.params.id, req.body?.method || "native")),
  );
  return router;
}
