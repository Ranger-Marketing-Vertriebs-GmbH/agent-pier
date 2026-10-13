import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { serverMessages } from "../../lib/i18n/de.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";

/**
 * Each refresh asks the Gateway to rediscover provider models. Concurrent reads
 * share one Gateway call; one owner budget bounds the rest. Build it when the app
 * starts, not while answering a request.
 */
export function modelRefreshRateLimit() {
  return rateLimit({
    windowMs: 60_000,
    limit: 12,
    keyGenerator: () => "owner",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      const message = serverMessages.assistants.modelsRateLimited;
      res.status(429).json({
        code: "models-rate-limited",
        error: message,
        ...messageIdentity(message),
      });
    },
  });
}

export function assistantAccountRoutes({
  assistantModelAccounts: accounts,
  assistantModelLogin: login,
  assistants,
  modelRefreshLimit = modelRefreshRateLimit(),
}) {
  const router = Router();
  router.use(
    ["/assistant-model-accounts", "/assistant-model-login"],
    (_req, res, next) => {
      res.set("Cache-Control", "no-store");
      next();
    },
  );
  router.get("/assistant-model-accounts", async (_req, res) => {
    accounts.ensureModels();
    res.json({ accounts: await accounts.list() });
  });
  router.post("/assistant-model-accounts/:id/check", async (req, res) => {
    const result = await assistants.admit(() => accounts.check(req.params.id));
    assistants.changed();
    res.json(result);
  });
  router.post(
    "/assistant-model-accounts/:id/models/refresh",
    modelRefreshLimit,
    async (req, res) => {
      // The catalog publishes its own change event when the read ends. Maintenance
      // already refuses this POST (activeAssistantRoutes); admission is not used,
      // because a read of up to two minutes would hold every other admission.
      res.json(await accounts.refreshModels(req.params.id));
    },
  );
  router.delete("/assistant-model-accounts/:id", async (req, res) =>
    res.json({ accounts: await assistants.logoutAccount(accounts, req.params.id) }),
  );
  router.post("/assistant-model-login", async (_req, res) =>
    res.status(202).json(await assistants.admit(() => login.start())),
  );
  router.get("/assistant-model-login/:id", (req, res) =>
    res.json(login.status(req.params.id)),
  );
  router.delete("/assistant-model-login/:id", async (req, res) =>
    res.json(await login.cancel(req.params.id)),
  );
  router.use((error, _req, _res, next) => {
    // Never forward upstream provider messages or OAuth state to a browser.
    const key = { 400: "invalid", 404: "notFound", 409: "active" }[error.status];
    next(assistantProblem(key || "unavailable", key ? error.status : 503));
  });
  return router;
}
