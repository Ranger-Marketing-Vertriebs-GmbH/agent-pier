import {
  requireChatInput,
  requireCurrentChatInput,
} from "../../application/request-input-guard.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { Router } from "express";
import { problem, nameValue } from "../../lib/storage.js";
export function sessionsRoutes(services) {
  const {
    sessions,
    launch,
    activity,
    chat,
    bindings,
    github,
    models,
    memoryIntegration,
    requests,
    chatAttachments,
    chatDelivery,
    sshSessions,
  } = services;
  const router = Router();
  router.post("/sessions", async (req, res) =>
    res.status(201).json(await launch(req.body)),
  );
  router.get("/sessions/:id/reload", async (req, res) =>
    res.json(await services.reload.status(req.params.id)),
  );
  router.post("/sessions/:id/reload", async (req, res) =>
    res.json(await services.reload.request(req.params.id, req.body)),
  );
  router.delete("/sessions/:id/reload", async (req, res) =>
    res.json(await services.reload.cancel(req.params.id)),
  );
  router.patch("/sessions/:id", async (req, res) => {
    const name = nameValue(req.body?.name);
    await sessions.rename(req.params.id, name);
    res.json(await sessions.get(req.params.id));
  });
  router.post("/sessions/:id/stop", async (req, res) => {
    await services.reload?.cancel(req.params.id);
    await sessions.stop(req.params.id);
    res.json(await sessions.get(req.params.id));
  });
  router.delete("/sessions/:id", async (req, res) => {
    // Capture the directory before removal so a rejected (running) session
    // never loses its images: only a session actually removed gets its
    // attachment directory deleted.
    const directory = (await sessions.get(req.params.id)).attachments?.directory;
    await sessions.remove(req.params.id);
    sshSessions?.discard(req.params.id);
    await services.sshIntegration?.discard(req.params.id);
    await chatDelivery.discard(req.params.id);
    await chatAttachments.discard(req.params.id, directory);
    await requests.discard(req.params.id);
    await memoryIntegration.discard(req.params.id);
    activity.remove(req.params.id);
    chat.remove(req.params.id);
    await bindings.discard(req.params.id);
    await github.discard(req.params.id);
    models.remove(req.params.id);
    res.status(204).end();
  });
  router.get("/sessions/:id/screen", async (req, res) =>
    res.json({ text: await sessions.screen(req.params.id) }),
  );
  router.get("/sessions/:id/input/:deliveryId", async (req, res) =>
    res.json(
      await chatDelivery.status(req.params.id, req.params.deliveryId, req.query.scope),
    ),
  );
  router.post("/sessions/:id/input", async (req, res) => {
    if (
      typeof req.body?.text !== "string" ||
      req.body.text.length > 32000 ||
      typeof req.body.submit !== "boolean"
    )
      throw problem(serverMessages.http.invalidTerminalInput);
    if (Object.hasOwn(req.body, "deliveryId"))
      return res.json(await chatDelivery.send(req.params.id, req.body));
    await requireChatInput(requests, req.params.id);
    await sessions.input(
      req.params.id,
      req.body.text,
      req.body.submit,
      async (session, raw) => {
        requireCurrentChatInput(requests, req.params.id);
        return models.guardInput(req.params.id, session, raw);
      },
    );
    res.json({ ok: true });
  });
  return router;
}
