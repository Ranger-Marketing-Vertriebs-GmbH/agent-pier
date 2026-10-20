import { Router } from "express";
import { sessionToken } from "../login.js";
import { notFoundBody } from "../responses.js";

/** A restricted user's own account. */
export function meAccountRoutes({ users, dictation }) {
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
  // The current session stays; every other session of the user ends.
  router.put("/me/password", async (req, res) => {
    const { current, next } = req.body && typeof req.body === "object" ? req.body : {};
    await users.changePassword(
      req.principal.userId,
      { current, next },
      sessionToken(req),
    );
    res.sendStatus(204);
  });
  return router;
}
