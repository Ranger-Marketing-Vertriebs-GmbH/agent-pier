import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
export function assistantChannelRoutes({
  assistantChannels: channels,
  assistantSpeech: speech,
}) {
  const router = Router();
  router.use(["/assistant-channels", "/assistant-speech"], (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/assistant-channels", (_req, res) => res.json(channels.list()));
  router.post("/assistant-channels", async (req, res) =>
    res.status(201).json(await channels.create(req.body)),
  );
  router.patch("/assistant-channels/:id", async (req, res) =>
    res.json(await channels.update(req.params.id, req.body)),
  );
  router.post("/assistant-channels/:id/pair", async (req, res) =>
    res.json(
      await channels.pair(
        req.params.id,
        req.body?.revision,
        req.body?.appUrl,
        req.body?.language,
      ),
    ),
  );
  router.delete("/assistant-channels/:id", async (req, res) =>
    res.json(await channels.disconnect(req.params.id, req.body?.revision)),
  );
  router.post("/assistant-channels/:id/inputs/:inputId/:action", async (req, res) =>
    res.json(
      await channels.recoverInput(req.params.id, req.params.inputId, req.params.action),
    ),
  );
  router.post(
    "/assistant-channels/:id/notifications/:notificationId/:action",
    async (req, res) =>
      res.json(
        await channels.recoverNotification(
          req.params.id,
          req.params.notificationId,
          req.params.action,
        ),
      ),
  );
  router.get("/assistant-speech", (_req, res) => res.json(speech.get()));
  router.put("/assistant-speech", (req, res) => res.json(speech.save(req.body)));
  router.use((error, _req, _res, next) => {
    const key =
      {
        TELEGRAM_WEBHOOK: "channelWebhook",
        TELEGRAM_CONFLICT: "channelPolling",
        TELEGRAM_TOKEN: "channelToken",
      }[error.code] || { 400: "invalid", 404: "notFound", 409: "conflict" }[error.status];
    next(assistantProblem(key || "channelUnavailable", key ? error.status : 503));
  });
  return router;
}
