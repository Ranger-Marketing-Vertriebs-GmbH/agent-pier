import { Router } from "express";

/** The owner's split views: the whole document, create, change and delete one view. */
export function viewsRoutes({ views }) {
  const router = Router();
  router.get("/views", (_req, res) => res.json(views.list()));
  router.post("/views", (req, res) => res.status(201).json(views.create(req.body)));
  router.patch("/views/:id", (req, res) =>
    res.json(views.update(req.params.id, req.body)),
  );
  router.delete("/views/:id", (req, res) => res.json(views.remove(req.params.id)));
  return router;
}
