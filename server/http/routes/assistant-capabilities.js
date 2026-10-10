import { Router } from "express";
export function assistantCapabilityRoutes({ assistantMemory, assistantReminders }) {
  const router = Router();
  router.get("/assistants/:id/memory", async (req, res) =>
    res.json(await assistantMemory.read(req.params.id, req.query.name || "MEMORY.md")),
  );
  router.put("/assistants/:id/memory", async (req, res) =>
    res.json(await assistantMemory.write(req.params.id, req.body)),
  );
  router.get("/assistants/:id/memory/files", async (req, res) =>
    res.json(await assistantMemory.files(req.params.id)),
  );
  router.get("/assistants/:id/memory/search", async (req, res) =>
    res.json(await assistantMemory.search(req.params.id, req.query.q)),
  );
  router.get("/assistants/:id/reminders", async (req, res) =>
    res.json(await assistantReminders.list(req.params.id)),
  );
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
