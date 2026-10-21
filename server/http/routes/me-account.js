import { Router } from "express";
import { sessionToken } from "../login.js";
import { notFoundBody } from "../responses.js";

/** A restricted user's own account. */
export function meAccountRoutes({ users, dictation, notifications }) {
  const router = Router();
  router.use("/me", (req, res, next) =>
    req.principal?.role === "user" ? next() : res.status(404).json(notFoundBody()),
  );
  router.get("/me", (req, res) => {
    const { id, username, displayName, ownerMayRead } = users.get(req.principal.userId);
    res.json({ user: { id, username, displayName }, ownerMayRead });
  });
  // Dictation uses the owner's speech connection; the user learns only whether it works.
  router.get("/me/dictation", (_req, res) => {
    const { available, autoSend } = dictation.status();
    res.set("Cache-Control", "no-store");
    res.json({ available, autoSend });
  });
  // The current session stays; every other session of the user ends, and with it the
  // push devices of every browser but this one (`deviceId`).
  router.put("/me/password", async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { current, next, deviceId } = body;
    await users.changePassword(
      req.principal.userId,
      { current, next },
      sessionToken(req),
    );
    notifications?.forgetUser(req.principal.userId, { except: deviceId });
    res.sendStatus(204);
  });
  return router;
}
