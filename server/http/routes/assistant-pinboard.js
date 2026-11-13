import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { PAGE_CSP, PAGE_GRANT } from "../../features/assistants/agent-pinboard-pages.js";
import { principalOf } from "../../features/users/identity.js";
import { sendFileRange } from "../byte-ranges.js";
import { sessionToken } from "../login.js";
import { notFoundBody } from "../responses.js";
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
    const url = await pinboard().pages.issue(req.params.id, req.params.entryId, session);
    res.json({ url });
  });
  return router;
}

/**
 * The files of a pinned HTML page, for the reader's sandboxed frame: mounted ahead of
 * the session check, since the frame's opaque origin sends no session cookie;
 * authorizeRequest admits its cross-site requests on this path only (security.js).
 * The grant in the path stands in for the cookie: it names one entry, and the session
 * it was issued to must still be the owner's, signed in, and allowed to read the
 * agent (the owner's privacy window). Every refusal is a plain not found.
 */
export function pinboardPageRoutes(
  services,
  { read = assistantAttachmentRateLimits().attachmentReadLimit } = {},
) {
  const router = Router();
  const refuse = (res) => res.status(404).json(notFoundBody());
  router.get("/pinboard-pages/:grant/*path", read, async (req, res) => {
    // AgentPier's own headers give way to the page's: it may be framed by the app.
    res.removeHeader("X-Frame-Options");
    res.set({
      "Content-Security-Policy": PAGE_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, no-store",
    });
    // The path as sent, still encoded: pageFilePath decodes each segment itself.
    const [, token, rest] = /^\/pinboard-pages\/([^/]+)\/(.+)$/.exec(req.path) || [];
    const assistants = services.assistants;
    const board = assistants?.pinboard;
    const grant = PAGE_GRANT.test(token || "")
      ? board?.pages.grants.resolve(token)
      : null;
    if (!grant) return refuse(res);
    if (assistants.closed || assistants.recovering || assistants.maintenance)
      return refuse(res);
    let file;
    try {
      const session = services.identity.require(grant.session);
      if (principalOf(session).role !== "owner") return refuse(res);
      const agent = assistants.store.getAssistant(grant.assistantId);
      if (services.ownerPrivacy && !services.ownerPrivacy.agentContent(agent))
        return refuse(res);
      file = await board.pages.file(grant.assistantId, grant.entryId, rest.split("/"));
    } catch {
      return refuse(res);
    }
    res.set({ "Content-Type": file.type, "Content-Disposition": "inline" });
    // A font is fetched in CORS mode from the frame's opaque origin ("null").
    if (file.font) res.set("Access-Control-Allow-Origin", "*");
    await sendFileRange(req, res, file);
  });
  return router;
}
