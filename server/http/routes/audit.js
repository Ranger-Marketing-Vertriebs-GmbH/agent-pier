import { Router } from "express";

/**
 * The owner's audit log. Entries a user caused name her by her current display name;
 * a deleted user's entries keep her id and get `actorName: null`.
 */
export function auditRoutes({ audit, users }) {
  const router = Router();
  router.get("/audit", (req, res) => {
    const page = audit.list(req.query);
    const names = new Map(
      (users?.list() || []).map((user) => [user.id, user.displayName]),
    );
    res.json({
      ...page,
      events: page.events.map((event) =>
        event.actorUserId === undefined
          ? event
          : { ...event, actorName: names.get(event.actorUserId) ?? null },
      ),
    });
  });
  return router;
}
