import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";

export function assistantAccountRoutes({
  assistantModelAccounts: accounts,
  assistantModelLogin: login,
  assistants,
}) {
  const router = Router();
  router.use(
    ["/assistant-model-accounts", "/assistant-model-login"],
    (_req, res, next) => {
      res.set("Cache-Control", "no-store");
      next();
    },
  );
  router.get("/assistant-model-accounts", async (_req, res) =>
    res.json({ accounts: await accounts.list() }),
  );
  router.post("/assistant-model-accounts/:id/check", async (req, res) => {
    const result = await assistants.admit(() => accounts.check(req.params.id));
    assistants.changed();
    res.json(result);
  });
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
