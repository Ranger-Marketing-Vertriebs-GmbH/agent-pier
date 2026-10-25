import { Router } from "express";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

const createKeys = ["name", "description", "projectId", "value"];

/** Rejects a body that is no object or carries a key outside `allowed`. */
function body(req, allowed) {
  const input = req.body;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key))
  )
    throw Object.assign(problem(serverMessages.secrets.invalidBody, 400), {
      code: "SECRET_INVALID",
    });
  return input;
}

/** The owner's agent secrets; values go in, never out (owner-only by route-access.js). */
export function secretsRoutes({ secrets }) {
  const router = Router();
  router.get("/secrets", (_req, res) => res.json({ secrets: secrets.list() }));
  router.post("/secrets", (req, res) =>
    res.status(201).json(secrets.create(body(req, createKeys), req.principal)),
  );
  router.patch("/secrets/:id", (req, res) =>
    res.json(secrets.update(req.params.id, body(req, createKeys), req.principal)),
  );
  router.delete("/secrets/:id", (req, res) => {
    secrets.remove(req.params.id, req.principal);
    res.status(204).end();
  });
  return router;
}
