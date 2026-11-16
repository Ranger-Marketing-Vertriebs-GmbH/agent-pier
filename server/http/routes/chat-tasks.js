import { Router } from "express";

/** What a session's task sheet reads and does: transcripts, shell output, stopping. */
export function chatTaskRoutes({ taskReads: reads, taskControl: control }) {
  const router = Router();
  router.get("/sessions/:id/tasks/:taskId/transcript", async (req, res) =>
    res
      .set("Cache-Control", "no-store")
      .json(await reads.transcript(req.params.id, req.params.taskId)),
  );
  router.get("/sessions/:id/tasks/:taskId/output", async (req, res) =>
    res
      .set("Cache-Control", "no-store")
      .json(await reads.output(req.params.id, req.params.taskId)),
  );
  router.post("/sessions/:id/tasks/:taskId/stop", async (req, res) =>
    res
      .set("Cache-Control", "no-store")
      .json(await control.stop(req.params.id, req.params.taskId)),
  );
  return router;
}
