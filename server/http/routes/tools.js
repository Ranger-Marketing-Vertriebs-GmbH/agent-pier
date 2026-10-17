import { Router } from "express";
import { withCliVersions } from "../../features/tools/cli-version.js";

export function toolsRoutes(services) {
  const { installer } = services;
  const router = Router();
  router.post("/tools/:id/update", async (req, res) =>
    res.status(202).json(installer.startUpdate(req.params.id)),
  );
  router.get("/tool-installations", async (_req, res) => {
    const list = installer.list();
    const detected = await withCliVersions(installer.detect());
    // The installed version beside the job record, whose own `version` is what the
    // last installation or update reported.
    for (const item of list.installations) {
      const found = detected.find((tool) => tool.id === item.tool);
      if (found?.minimumVersion)
        Object.assign(item, {
          installedVersion: found.version,
          minimumVersion: found.minimumVersion,
          versionStatus: found.versionStatus,
        });
    }
    res.json(list);
  });
  router.post("/tools/:id/install", async (req, res) =>
    res.status(202).json(installer.start(req.params.id, req.body?.method || "native")),
  );
  return router;
}
