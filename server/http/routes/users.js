import { Router } from "express";
import { notFoundBody } from "../responses.js";

const body = (req) => (req.body && typeof req.body === "object" ? req.body : {});

/** The owner's administration of restricted users. */
export function usersRoutes({ users }) {
  const router = Router();
  // Users never learn that these routes exist (the user guard refuses them first).
  router.use("/users", (req, res, next) =>
    req.principal?.role === "owner" ? next() : res.status(404).json(notFoundBody()),
  );
  router.get("/users", (_req, res) => res.json(users.list()));
  router.post("/users", async (req, res) => {
    const { username, displayName, password } = body(req);
    res.status(201).json(await users.create({ username, displayName, password }));
  });
  router.patch("/users/:id", (req, res) => {
    const { displayName, disabled } = body(req);
    res.json(users.update(req.params.id, { displayName, disabled }));
  });
  router.post("/users/:id/password", async (req, res) => {
    await users.resetPassword(req.params.id, body(req).password);
    res.sendStatus(204);
  });
  router.delete("/users/:id", (req, res) => {
    users.remove(req.params.id);
    res.sendStatus(204);
  });
  return router;
}
