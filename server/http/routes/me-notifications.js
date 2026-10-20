import { Router } from "express";
import { notFoundBody } from "../responses.js";

/**
 * A restricted user's own devices: push subscriptions, their preferences and quiet
 * hours, presence and a test push. She sees and changes only her devices; the owner's
 * and other users' are not found. She gets notices about her own agents and chats.
 */
export function meNotificationRoutes({ notifications, audit }) {
  const router = Router();
  router.use("/me/notifications", (req, res, next) =>
    req.principal?.role === "user" ? next() : res.status(404).json(notFoundBody()),
  );
  const mine = (req) => ({ userId: req.principal.userId });
  const record = (req, action, id, outcome = "success") =>
    audit.append({
      action,
      resourceType: "notification",
      resourceId: id,
      outcome,
      source: "user",
      actorUserId: req.principal.userId,
    });
  router.get("/me/notifications", (req, res) =>
    res.json(notifications.status(mine(req))),
  );
  router.post("/me/notifications/subscriptions", async (req, res) => {
    const result = await notifications.subscribe(req.body, mine(req));
    record(req, "notification.subscribed", result.subscription.id);
    res.status(201).json(result);
  });
  router.delete("/me/notifications/subscriptions/:id", async (req, res) => {
    const result = await notifications.unsubscribe(req.params.id, mine(req));
    record(req, "notification.unsubscribed", req.params.id);
    res.json(result);
  });
  router.put("/me/notifications/subscriptions/:id/preferences", async (req, res) => {
    const result = await notifications.setPreferences(req.params.id, req.body, mine(req));
    record(req, "notification.updated", req.params.id);
    res.json(result);
  });
  router.post("/me/notifications/presence", (req, res) => {
    notifications.reportPresence(req.body?.route, mine(req));
    res.status(204).end();
  });
  router.post("/me/notifications/test", async (req, res) => {
    const result = await notifications.test(req.body?.subscriptionId, mine(req));
    record(
      req,
      "notification.tested",
      req.body.subscriptionId,
      result.sent ? "success" : "failure",
    );
    res.json(result);
  });
  return router;
}
