import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { sessionToken } from "../login.js";
import { pageClient } from "./pinboard-pages.js";
import {
  assistantAttachmentRateLimits,
  sendAttachment,
} from "./assistant-attachments.js";

/**
 * Owner routes of an agent's pinboard (agent-pinboard.js): the lists, marking an
 * entry seen, and the pinned file's bytes. Owner-only: restricted users never reach
 * /api/assistants/* (route-access.js), and the owner-content guard refuses a user's
 * own agent without her opt-in (owner-content-routes.js). Problems keep their own
 * keys (agentPinboard.*); assistantErrors would turn them into assistants.notFound.
 */
export function assistantPinboardRoutes({
  assistants,
  identity,
  attachmentReadLimit: read = assistantAttachmentRateLimits().attachmentReadLimit,
}) {
  const router = Router();
  const base = "/assistants/:id/pinboard";
  // Every route opens workspace files: none while a restore or update may replace them.
  const pinboard = () => {
    if (
      assistants.closed ||
      assistants.recovering ||
      assistants.maintenance ||
      !assistants.pinboard
    )
      throw assistantProblem("unavailable", 503);
    return assistants.pinboard;
  };
  router.use(base, (_req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    next();
  });
  router.get(base, read, async (req, res) => {
    res.json(await pinboard().view(req.params.id));
  });
  router.post(`${base}/entries/:entryId/seen`, read, async (req, res) => {
    await pinboard().seen(req.params.id, req.params.entryId);
    res.status(204).end();
  });
  // The bytes come from the descriptor the share rules checked; a file that fails
  // them now, for whatever reason, answers 404 before a byte is sent.
  // `?download=1` saves the file by its name, also one shown or played inline.
  router.get(`${base}/entries/:entryId/file`, read, async (req, res) => {
    const board = pinboard();
    let file;
    try {
      file = await board.open(req.params.id, req.params.entryId);
    } catch {
      throw assistantProblem("pinboardUnavailable", 404);
    }
    await sendAttachment(req, res, file);
  });
  // A pinned HTML page: a grant for this entry and this session (agent-pinboard-pages.js)
  // and the page's URL below it, for the reader's sandboxed frame.
  router.get(`${base}/entries/:entryId/page`, read, async (req, res) => {
    const session = sessionToken(req, identity);
    if (!session) throw assistantProblem("pinboardUnavailable", 404);
    const url = await pinboard().pages.issue(req.params.id, req.params.entryId, {
      session,
      client: pageClient(req),
    });
    res.json({ url });
  });
  return router;
}
