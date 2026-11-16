import { Router } from "express";
import { TaskReads } from "../../features/chat/task-reads.js";

/** What a session's task sheet reads: a subagent's transcript, a shell's output tail. */
export function chatTaskRoutes(services) {
  const reads =
    services.taskReads ??
    new TaskReads({
      sessions: services.sessions,
      chat: services.chat,
      history: services.history,
    });
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
  return router;
}
