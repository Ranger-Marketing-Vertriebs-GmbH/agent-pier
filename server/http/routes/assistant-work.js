import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { saveWork } from "../../features/assistants/assistant-work.js";
import { followLead } from "../../features/assistants/member-follow.js";
import { assistantErrors } from "./assistant-workflows.js";

// The agent settings "Work" tab: workflow access and team policy in one save.
export function assistantWorkRoutes({ assistants }) {
  const router = Router();
  router.put("/assistants/:id/work", (req, res) =>
    assistants.admit(async () => {
      if (!assistants.workflows || !assistants.teams)
        throw assistantProblem("unavailable", 503);
      const { sshToolChanged, ...saved } = saveWork(
        {
          assistants,
          access: assistants.workflows.access,
          teams: assistants.teams.store,
        },
        req.params.id,
        req.body,
      );
      // The next turn applies it anyway; a ready Gateway gets it now.
      if (sshToolChanged && assistants.runtime?.client?.ready)
        await assistants.config.apply(req.params.id).catch(() => {});
      // Running members follow the shell and SSH setting at once.
      if (req.body.team) {
        // Switched off, the setting also cancels pending shell and SSH cards.
        assistants.teams.grants?.settingOff(req.params.id);
        followLead(assistants, req.params.id);
      }
      res.json(saved);
    }),
  );
  router.use(assistantErrors);
  return router;
}
