import { Router } from "express";

export function repositoriesRoutes(services) {
  const { repositories, github } = services;
  const router = Router();
  router.get("/repositories", async (_req, res) =>
    res.json({
      credentials: repositories.listCredentials(),
      projects: repositories.listProjects(),
    }),
  );
  router.post("/git-credentials", async (req, res) => {
    const credential = repositories.createCredential(req.body);
    await github.sync();
    res.status(201).json(credential);
  });
  router.patch("/git-credentials/:id", async (req, res) => {
    const credential = repositories.updateCredential(req.params.id, req.body);
    await github.sync();
    res.json(credential);
  });
  router.delete("/git-credentials/:id", async (req, res) => {
    repositories.removeCredential(req.params.id);
    await github.sync();
    res.status(204).end();
  });
  router.post("/repositories/clone", async (req, res) =>
    res.status(201).json(await repositories.clone(req.body)),
  );
  router.get("/repositories/discover", async (req, res) =>
    res.json(
      await repositories.discover({
        credentialId: req.query.credentialId,
        query: req.query.q,
        organization: req.query.organization,
        page: req.query.page,
      }),
    ),
  );
  return router;
}
