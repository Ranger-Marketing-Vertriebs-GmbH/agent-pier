import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import {
  projectAgents,
  setProjectAgent,
} from "../../features/assistants/project-agent-access.js";
import { assistantErrors } from "./assistant-workflows.js";

// A project's Agents section: the agents' Work tab access, per project.
export function assistantProjectAccessRoutes({ assistants }) {
  const router = Router();
  const services = () => {
    if (!assistants.workflows || !assistants.teams)
      throw assistantProblem("unavailable", 503);
    return {
      assistants,
      access: assistants.workflows.access,
      teams: assistants.teams.store,
    };
  };
  router.get("/assistant-project-access/:projectId", (req, res) =>
    res.json(projectAgents(services(), req.params.projectId)),
  );
  router.put("/assistant-project-access/:projectId/:assistantId", (req, res) =>
    assistants.admit(async () =>
      res.json(
        setProjectAgent(
          services(),
          req.params.projectId,
          req.params.assistantId,
          req.body,
        ),
      ),
    ),
  );
  router.use(assistantErrors);
  return router;
}
