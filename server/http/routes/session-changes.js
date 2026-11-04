import { Router } from "express";
import { problem } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { validId } from "../../features/sessions/session-validation.js";

// A workspace id is a relative path label of at most this many characters.
const MAX_WORKSPACE_ID = 512;

function workspaceParam(query) {
  const workspace = query?.workspace;
  if (typeof workspace !== "string" || workspace.length > MAX_WORKSPACE_ID)
    throw problem(serverMessages.changes.invalidWorkspace, 400);
  return workspace;
}

/**
 * The owner's view of a session's working-tree changes (owner only, like every route
 * outside route-access.js userRoutes). `workspace` is matched against the workspaces
 * listed now; an id not listed answers 404, so a removed worktree reads as unknown.
 */
export function sessionChangesRoutes({ sessionChanges }) {
  const router = Router();
  router.get("/sessions/:id/changes", async (req, res) => {
    res.json(await sessionChanges.summary(validId(req.params.id)));
  });
  router.get("/sessions/:id/changes/diff", async (req, res) => {
    const id = validId(req.params.id);
    res.json(await sessionChanges.diff(id, workspaceParam(req.query)));
  });
  return router;
}
