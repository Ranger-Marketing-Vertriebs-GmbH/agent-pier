import { Router } from "express";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
export function notificationsRoutes({ notifications, audit }) {
  const router = Router();
  const record = (action, id, outcome = "success") =>
    audit.append({
      action,
      resourceType: "notification",
      resourceId: id,
      outcome,
      source: "user",
    });
  router.get("/notifications", (_req, res) => res.json(notifications.status()));
  router.post("/notifications/subscriptions", async (req, res) => {
    const result = await notifications.subscribe(req.body);
    record("notification.subscribed", result.subscription.id);
    res.status(201).json(result);
  });
  router.delete("/notifications/subscriptions/:id", async (req, res) => {
    const result = await notifications.unsubscribe(req.params.id);
    record("notification.unsubscribed", req.params.id);
    res.json(result);
  });
  router.put("/notifications/subscriptions/:id/preferences", async (req, res) => {
    const result = await notifications.setPreferences(req.params.id, req.body);
    record("notification.updated", req.params.id);
    res.json(result);
  });
  // A visible page names its view, so pushes about it are held back (push-presence.js).
  // Nothing is stored or audited.
  router.post("/notifications/presence", (req, res) => {
    if (!notifications.reportPresence(req.body?.route))
      throw problem(serverMessages.notifications.presenceRateLimit, 429);
    res.status(204).end();
  });
  router.post("/notifications/test", async (req, res) => {
    const result = await notifications.test(req.body?.subscriptionId);
    record(
      "notification.tested",
      req.body.subscriptionId,
      result.sent ? "success" : "failure",
    );
    res.json(result);
  });
  return router;
}
