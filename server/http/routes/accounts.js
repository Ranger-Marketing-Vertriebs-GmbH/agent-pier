import { serverMessages } from "../../lib/i18n/de.js";
import { Router } from "express";
import { problem } from "../../lib/storage.js";
export function accountsRoutes(services) {
  const { accounts, plugins, activeFor, launch } = services;
  const router = Router();
  router.get("/accounts/:id/auth-status", async (req, res) =>
    res.json(await services.accountAuthStatus.get(req.params.id)),
  );
  router.post("/accounts", async (req, res) =>
    res.status(201).json(accounts.create(req.body)),
  );
  async function assertMutable(id, requiresIdle, message) {
    const active = requiresIdle && (await activeFor(id));
    if (plugins.isBusy(id))
      throw problem(serverMessages.accounts.waitForPluginOperation, 409);
    if (active) throw problem(message, 409);
  }
  router.patch("/accounts/:id", async (req, res) => {
    const changesCredentials =
      !!req.body?.apiKey ||
      req.body?.removeApiKey === true ||
      Object.hasOwn(req.body || {}, "provider");
    await assertMutable(
      req.params.id,
      changesCredentials,
      serverMessages.accounts.stopBeforeKeyChange,
    );
    res.json(accounts.update(req.params.id, req.body));
  });
  router.delete("/accounts/:id", async (req, res) => {
    await assertMutable(req.params.id, true, serverMessages.accounts.stopBeforeDelete);
    accounts.remove(req.params.id);
    res.status(204).end();
  });
  router.post("/accounts/:id/login", async (req, res) =>
    res.status(201).json(await launch({ accountId: req.params.id }, true)),
  );
  return router;
}
