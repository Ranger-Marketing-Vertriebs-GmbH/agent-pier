import { Router } from "express";
import { ownerBinding, ownerPerson } from "./binding-scope.js";
import { memoryOffset } from "../../features/assistants/native-memory.js";
export function assistantCapabilityRoutes(services) {
  const { assistants, assistantMemory, assistantReminders } = services;
  const router = Router();
  // The agent's own browser: whether it runs, and deleting its profile.
  router.get("/assistants/:id/browser", (req, res) =>
    res.json(assistants.browsers.status(req.params.id)),
  );
  router.post("/assistants/:id/browser/reset", async (req, res) =>
    res.json(await assistants.browsers.reset(req.params.id)),
  );
  router.get("/assistants/:id/memory", async (req, res) =>
    res.json(await assistantMemory.read(req.params.id, req.query.name || "MEMORY.md")),
  );
  router.put("/assistants/:id/memory", async (req, res) =>
    res.json(await assistantMemory.write(req.params.id, req.body)),
  );
  router.get("/assistants/:id/memory/files", async (req, res) =>
    res.json(
      await assistantMemory.files(req.params.id, {
        offset: memoryOffset(req.query.offset),
      }),
    ),
  );
  router.get("/assistants/:id/memory/search", async (req, res) =>
    res.json(await assistantMemory.search(req.params.id, req.query.q)),
  );
  router.get("/assistants/:id/reminders", async (req, res) =>
    res.json(
      await assistantReminders.list(req.params.id, {
        userId: ownerPerson(assistants, req.params.id),
      }),
    ),
  );
  // Another user's reminder on a shared agent is not the owner's to see or change.
  router.use("/assistants/:id/reminders/:bindingId", ownerBinding(services, "bindingId"));
  router.post("/assistants/:id/reminders", async (req, res) =>
    res.status(201).json(await assistantReminders.create(req.params.id, req.body)),
  );
  router.patch("/assistants/:id/reminders/:bindingId", async (req, res) =>
    res.json(
      await assistantReminders.update(req.params.id, req.params.bindingId, req.body),
    ),
  );
  router.delete("/assistants/:id/reminders/:bindingId", async (req, res) =>
    res.json(await assistantReminders.remove(req.params.id, req.params.bindingId)),
  );
  router.post("/assistants/:id/reminders/:bindingId/review", async (req, res) =>
    res.json(
      await assistantReminders.review(req.params.id, req.params.bindingId, req.body),
    ),
  );
  router.get("/assistants/:id/reminders/:bindingId/runs", async (req, res) =>
    res.json(await assistantReminders.runs(req.params.id, req.params.bindingId)),
  );
  return router;
}
