import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { saveWork } from "../../features/assistants/assistant-work.js";
import { assistantErrors } from "./assistant-workflows.js";

// The agent settings "Work" tab: workflow access and team policy in one save.
export function assistantWorkRoutes({ assistants }) {
  const router = Router();
  router.put("/assistants/:id/work", (req, res) =>
    assistants.admit(() => {
      if (!assistants.workflows || !assistants.teams)
        throw assistantProblem("unavailable", 503);
      res.json(
        saveWork(
          {
            assistants,
            access: assistants.workflows.access,
            teams: assistants.teams.store,
          },
          req.params.id,
          req.body,
        ),
      );
    }),
  );
  router.use(assistantErrors);
  return router;
}
