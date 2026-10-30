import { Router } from "express";
import { decideFromPush } from "../../application/push-decisions.js";
export function notificationsRoutes({ notifications, audit, requests, assistants }) {
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
  // The browser's renewed subscription for a device already registered (no new device).
  router.post("/notifications/renew", async (req, res) => {
    const result = await notifications.renew(req.body);
    if (result.renewed) record("notification.updated", result.subscription.id);
    res.json({ subscription: result.subscription });
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
  // Nothing is stored or audited; reports beyond the rate limit are ignored quietly.
  router.post("/notifications/presence", (req, res) => {
    notifications.reportPresence(req.body?.route);
    res.status(204).end();
  });
  // Allow or Deny on an approval notification (public/sw.js); the owner's items only.
  router.post("/notifications/decide", async (req, res) =>
    res.json(await decideFromPush({ requests, assistants }, req.body)),
  );
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
