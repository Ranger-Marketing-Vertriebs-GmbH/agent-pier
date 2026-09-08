import { Router } from "express";
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
