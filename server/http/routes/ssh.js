import { Router } from "express";
import { problem } from "../../lib/storage.js";

export function sshRoutes({ sshAccesses, sshSessions, sessions, sshIntegration }) {
  const router = Router();
  router.get("/ssh-keys", (_req, res) => res.json({ keys: sshAccesses.keyStore.list() }));
  router.post("/ssh-keys", async (req, res) =>
    res.status(201).json(await sshAccesses.keyStore.create(req.body)),
  );
  router.patch("/ssh-keys/:id", (req, res) =>
    res.json(sshAccesses.keyStore.rename(req.params.id, req.body)),
  );
  router.delete("/ssh-keys/:id", (req, res) => {
    sshAccesses.keyStore.remove(req.params.id);
    res.status(204).end();
  });
  router.get("/ssh-accesses", (_req, res) => res.json({ accesses: sshAccesses.list() }));
  router.post("/ssh-accesses/scan", async (req, res) =>
    res.json(await sshAccesses.scan(req.body)),
  );
  router.post("/ssh-accesses", async (req, res) =>
    res.status(201).json(await sshAccesses.create(req.body)),
  );
  router.patch("/ssh-accesses/:id", async (req, res) =>
    res.json(await sshAccesses.update(req.params.id, req.body)),
  );
  router.post("/ssh-accesses/:id/test", async (req, res) =>
    res.json(await sshAccesses.test(req.params.id)),
  );
  router.delete("/ssh-accesses/:id", (req, res) => {
    sshAccesses.get(req.params.id);
    // Revoke before removing the host, so helpers fail closed during deletion.
    sshSessions.revokeAccess(req.params.id);
    sshAccesses.remove(req.params.id);
    res.status(204).end();
  });
  const sessionAccesses = (session, result = sshSessions.get(session)) => ({
    ...result,
    ...(sshIntegration ? { tools: sshIntegration.status(session) } : {}),
  });
  router.get("/sessions/:id/ssh-accesses", async (req, res) =>
    res.json(sessionAccesses(await sessions.get(req.params.id))),
  );
  router.put("/sessions/:id/ssh-accesses", async (req, res) => {
    if (
      !req.body ||
      !Array.isArray(req.body.accessIds) ||
      Object.keys(req.body).some((key) => key !== "accessIds")
    )
      throw problem("Ungültige SSH-Zuordnung.");
    const session = await sessions.get(req.params.id);
    res.json(sessionAccesses(session, sshSessions.set(session, req.body.accessIds)));
  });
  return router;
}
