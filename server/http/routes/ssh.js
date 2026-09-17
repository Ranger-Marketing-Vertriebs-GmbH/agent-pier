import fs from "node:fs";
import { Router } from "express";
import { problem } from "../../lib/storage.js";

export function sshRoutes({
  sshAccesses,
  sshSessions,
  sessions,
  sshIntegration,
  sshManagement,
}) {
  const router = Router();
  const mutate = (action, input, fallback) =>
    sshManagement ? sshManagement.ui(action, input) : fallback();
  router.get("/ssh-projects", async (_req, res) =>
    res.json(sshManagement ? await sshManagement.projects() : { projects: [] }),
  );
  router.post("/ssh-projects/reassign", async (req, res) => {
    if (
      !sshManagement ||
      !req.body ||
      Object.keys(req.body).some((key) => !["fromProjectId", "toProjectId"].includes(key))
    )
      throw Object.assign(problem("Invalid SSH project reassignment."), {
        code: "SSH_INVALID_ARGUMENT",
      });
    try {
      res.json(await sshManagement.ui("reassign", req.body));
    } catch (error) {
      if (error.code !== "SSH_PROJECT_COLLISION") throw error;
      const resourceIds = Array.isArray(error.details?.resourceIds)
        ? error.details.resourceIds
            .filter((id) => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id))
            .slice(0, 100)
        : [];
      res.status(409).json({
        code: "SSH_PROJECT_COLLISION",
        error: "The target project already contains a matching key or host.",
        details: { resourceIds, truncated: error.details?.truncated === true },
      });
    }
  });
  router.post("/ssh-keys/:id/download", (req, res) => {
    const file = sshAccesses.keyStore.openPrivate(req.params.id);
    try {
      const bytes = Buffer.alloc(file.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(file.fd, bytes, offset, bytes.length - offset, offset);
        if (!count)
          throw Object.assign(problem("SSH key download failed.", 409), {
            code: "SSH_DOWNLOAD_FAILED",
          });
        offset += count;
      }
      sshManagement?.emit("ssh.key.exported", req.params.id);
      res
        .set({
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${file.filename}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        })
        .send(bytes);
    } finally {
      fs.closeSync(file.fd);
    }
  });
  router.get("/ssh-keys", (_req, res) => res.json({ keys: sshAccesses.keyStore.list() }));
  router.post("/ssh-keys", async (req, res) =>
    res
      .status(201)
      .json(
        await mutate("createKey", req.body, () => sshAccesses.keyStore.create(req.body)),
      ),
  );
  router.patch("/ssh-keys/:id", async (req, res) =>
    res.json(
      await mutate("renameKey", { id: req.params.id, body: req.body }, () =>
        sshAccesses.keyStore.rename(req.params.id, req.body),
      ),
    ),
  );
  router.delete("/ssh-keys/:id", async (req, res) => {
    await mutate("removeKey", { id: req.params.id }, () =>
      sshAccesses.keyStore.remove(req.params.id),
    );
    res.status(204).end();
  });
  router.get("/ssh-accesses", (_req, res) => res.json({ accesses: sshAccesses.list() }));
  router.post("/ssh-accesses/scan", async (req, res) =>
    res.json(await sshAccesses.scan(req.body)),
  );
  router.post("/ssh-accesses", async (req, res) =>
    res
      .status(201)
      .json(await mutate("createHost", req.body, () => sshAccesses.create(req.body))),
  );
  router.patch("/ssh-accesses/:id", async (req, res) =>
    res.json(
      await mutate("updateHost", { id: req.params.id, body: req.body }, () =>
        sshAccesses.update(req.params.id, req.body),
      ),
    ),
  );
  router.post("/ssh-accesses/:id/test", async (req, res) =>
    res.json(await sshAccesses.test(req.params.id)),
  );
  router.delete("/ssh-accesses/:id", async (req, res) => {
    sshAccesses.get(req.params.id);
    // Revoke before removing the host, so helpers fail closed during deletion.
    sshSessions.revokeAccess(req.params.id);
    await mutate("removeHost", { id: req.params.id }, () =>
      sshAccesses.remove(req.params.id),
    );
    res.status(204).end();
  });
  const sessionAccesses = async (session, result) => ({
    ...(await (result ?? sshSessions.get(session))),
    ...(sshIntegration ? { tools: sshIntegration.status(session) } : {}),
  });
  router.get("/sessions/:id/ssh-accesses", async (req, res) =>
    res.json(await sessionAccesses(await sessions.get(req.params.id))),
  );
  router.put("/sessions/:id/ssh-accesses", async (req, res) => {
    if (
      !req.body ||
      !Array.isArray(req.body.accessIds) ||
      Object.keys(req.body).some((key) => key !== "accessIds")
    )
      throw problem("Ungültige SSH-Zuordnung.");
    const session = await sessions.get(req.params.id);
    res.json(
      await sessionAccesses(session, sshSessions.set(session, req.body.accessIds)),
    );
  });
  return router;
}
