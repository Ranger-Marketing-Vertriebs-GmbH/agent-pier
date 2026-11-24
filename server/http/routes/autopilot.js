import { Router } from "express";

export function autopilotRoutes({ autopilot }) {
  const router = Router(),
    base = "/autopilot/orders",
    one = base + "/:id";
  const { orders } = autopilot;
  router.get("/autopilot/projects", async (_req, res) =>
    res.json(await autopilot.projects()),
  );
  router.get(base, async (_req, res) => res.json(await orders.list()));
  router.post(base, async (req, res) =>
    res.status(201).json(await orders.create(req.body)),
  );
  router.get(one, async (req, res) =>
    res.json(await orders.get(req.params.id, { remote: true })),
  );
  router.patch(one, async (req, res) =>
    res.json(await orders.policy(req.params.id, req.body)),
  );
  router.post(one + "/pause", async (req, res) =>
    res.json(await orders.pause(req.params.id)),
  );
  router.post(one + "/resume", async (req, res) =>
    res.json(await orders.resume(req.params.id, req.body ?? {})),
  );
  router.delete(one, async (req, res) => {
    await orders.remove(req.params.id);
    res.sendStatus(204);
  });
  return router;
}
