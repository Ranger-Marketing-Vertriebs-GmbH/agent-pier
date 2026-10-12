import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { replyRestartRequired } from "./restart-required.js";

const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * An agent's own Telegram bot for other people. The token is accepted but never
 * returned; a change the running Gateway was not started with restarts it once the
 * owner confirms (`confirmRestart`).
 */
export function assistantTelegramSenderRoutes({ assistantTelegramSenders: senders }) {
  const router = Router();
  const base = "/assistant-telegram-senders";
  router.use(base, (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  const confirmed = (body) => ({
    confirmed: record(body) && body.confirmRestart === true,
  });
  const input = (body) => {
    if (!record(body)) return body;
    const { confirmRestart: _confirm, ...rest } = body;
    return rest;
  };
  router.post(`${base}/apply`, async (req, res) => {
    try {
      res.json(await senders.apply(confirmed(req.body)));
    } catch (error) {
      replyRestartRequired(res, error);
    }
  });
  router.get(`${base}/:assistantId`, async (req, res) =>
    res.json(await senders.get(req.params.assistantId)),
  );
  router.put(`${base}/:assistantId`, async (req, res) => {
    try {
      res.json(
        await senders.save(req.params.assistantId, input(req.body), confirmed(req.body)),
      );
    } catch (error) {
      replyRestartRequired(res, error);
    }
  });
  router.delete(`${base}/:assistantId`, async (req, res) => {
    try {
      res.json(
        await senders.remove(
          req.params.assistantId,
          req.body?.revision,
          confirmed(req.body),
        ),
      );
    } catch (error) {
      replyRestartRequired(res, error);
    }
  });
  router.use(base, (error, _req, _res, next) =>
    // Validation, conflicts and a busy Gateway keep their reason; Telegram, storage
    // and runtime errors can carry private details.
    next(error.key ? error : assistantProblem("unavailable", 503)),
  );
  return router;
}
