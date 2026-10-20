import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { notFoundBody } from "../responses.js";
import { userProblem } from "../../features/users/user-errors.js";
import { UserAgents } from "../../features/users/user-agents.js";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";

// Whether agents ever ran here: their store may hold a user's agents and chats.
const agentData = (dataDir) =>
  fs.existsSync(path.join(dataDir, "assistants", "assistants.sqlite"));
const body = (req) => (req.body && typeof req.body === "object" ? req.body : {});

/** The owner's administration of restricted users. */
export function usersRoutes(services) {
  const { users, ownerPrivacy } = services;
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
  router.patch("/users/:id", async (req, res) => {
    const { displayName, disabled } = body(req);
    const user = users.update(req.params.id, { displayName, disabled });
    // Disabling ends her sessions (UserStore) and everything that runs as her.
    if (disabled === true) await new UserAgents(services).disableUser(user.id);
    res.json(user);
  });
  // "Owner may read chats": from now on, never earlier; the user sees it in her app.
  router.put("/users/:id/owner-may-read", (req, res) => {
    const { enabled } = body(req);
    if (typeof enabled !== "boolean") throw userProblem("USER_CHANGE_INVALID");
    res.json(ownerPrivacy.set(req.params.id, enabled));
  });
  router.post("/users/:id/password", async (req, res) => {
    await users.resetPassword(req.params.id, body(req).password);
    res.sendStatus(204);
  });
  // Her own agents are archived or kept as the owner's ("agents"); the choice is
  // needed while she has any. Her chats go with her unless the owner may read them.
  router.delete("/users/:id", async (req, res) => {
    const { agents } = body(req);
    const user = users.get(req.params.id);
    if (agents !== undefined && !["archive", "keep"].includes(agents))
      throw userProblem("USER_CHANGE_INVALID");
    // Her agents and chats are released with her, which needs the agent services.
    if (!services.assistants && services.assistantFeature?.enabled)
      throw assistantProblem("unavailable", 503);
    if (!services.assistants && agentData(services.config.dataDir))
      throw userProblem("USER_AGENTS_OFF");
    const owned = new UserAgents(services);
    if (agents === undefined && owned.ownsAgents(user.id))
      throw userProblem("USER_AGENTS_CHOICE");
    await owned.releaseUser(user.id, agents ?? "archive", user.ownerMayRead);
    // Her push devices go with her, whether or not agents ever ran here.
    services.notifications?.forgetUser(user.id);
    users.remove(user.id);
    res.sendStatus(204);
  });
  return router;
}
