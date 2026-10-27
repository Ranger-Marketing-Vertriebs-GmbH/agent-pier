import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";

// The exact keys of a body; anything else is refused.
function body(req, allowed, required) {
  const input = req.body || {};
  if (
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    required.some((key) => !(key in input))
  )
    throw assistantProblem("invalid");
  return input;
}
const revision = (input) => {
  if (!Number.isSafeInteger(input.revision)) throw assistantProblem("invalid");
  return input.revision;
};

/**
 * Archive, restore and permanent delete of any agent (agent-lifecycle.js). Owner
 * routes: a restricted user reaches none of them (route-access.js).
 */
export function assistantLifecycleRoutes({ assistants }) {
  const router = Router();
  const lifecycle = () => {
    if (!assistants.lifecycle) throw assistantProblem("unavailable", 503);
    return assistants.lifecycle;
  };
  router.post("/assistants/:id/archive", async (req, res) => {
    const input = body(req, ["revision", "members"], ["revision"]);
    if ("members" in input && typeof input.members !== "boolean")
      throw assistantProblem("invalid");
    res.json(
      await lifecycle().archive(req.params.id, {
        revision: revision(input),
        members: input.members === true,
      }),
    );
  });
  router.post("/assistants/:id/restore", async (req, res) => {
    const input = body(req, ["revision"], ["revision"]);
    res.json(await lifecycle().restore(req.params.id, { revision: revision(input) }));
  });
  // What a delete would remove, as counts for the confirmation.
  router.get("/assistants/:id/deletion", async (req, res) =>
    res.json(await lifecycle().deletion(req.params.id)),
  );
  router.delete("/assistants/:id", async (req, res) => {
    const input = body(req, ["name"], ["name"]);
    await lifecycle().delete(req.params.id, { name: input.name });
    res.status(204).end();
  });
  return router;
}
