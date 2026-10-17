import { Router, raw } from "express";
import { rateLimit } from "express-rate-limit";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { MAX_ATTACHMENT_BYTES } from "../../features/assistants/agent-attachment-types.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";

/**
 * One owner budget for every client and proxy address, without trusting forwarded
 * IPs: uploads write into agent workspaces, reads open files there. Build both when
 * the app starts, not while answering a request.
 */
export function assistantAttachmentRateLimits() {
  const limited = (limit) =>
    rateLimit({
      windowMs: 60_000,
      limit,
      keyGenerator: () => "owner",
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_req, res) => {
        const message = serverMessages.assistants.attachmentRateLimited;
        res
          .status(429)
          .set("Cache-Control", "no-store")
          .json({ error: message, ...messageIdentity(message) });
      },
    });
  return { attachmentUploadLimit: limited(60), attachmentReadLimit: limited(600) };
}

const headerName = (name) =>
  encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
// The raw body may exceed the file limit slightly so the route answers with its own
// translated error; anything larger fails in the parser and is translated below.
const body = raw({ type: "application/octet-stream", limit: MAX_ATTACHMENT_BYTES + 1 });

/** Owner routes, behind the login: stage, discard and show chat attachments. */
export function assistantAttachmentRoutes({
  assistants,
  attachmentUploadLimit: upload = assistantAttachmentRateLimits().attachmentUploadLimit,
  attachmentReadLimit: read = assistantAttachmentRateLimits().attachmentReadLimit,
}) {
  const router = Router();
  const attachments = () => assistants.attachments;
  router.get("/assistant-conversations/:id/attachment-policy", read, (req, res) =>
    res.json(attachments().policy(req.params.id)),
  );
  router.post("/assistant-conversations/:id/attachments", upload, body, (req, res) =>
    assistants.admit(async () => {
      if (!req.is("application/octet-stream")) throw assistantProblem("invalid", 415);
      res
        .status(201)
        .json(await attachments().stage(req.params.id, req.query.name, req.body));
    }),
  );
  router.delete("/assistant-conversations/:id/attachments/:file", upload, (req, res) =>
    assistants.admit(async () => {
      await attachments().discard(req.params.id, req.params.file);
      res.status(204).end();
    }),
  );
  // The owner deletes a file an agent shared; every chat showing it says it is gone.
  router.delete("/assistant-conversations/:id/shared-files/:file", upload, (req, res) =>
    assistants.admit(async () => {
      await attachments().shared.remove(req.params.id, req.params.file);
      assistants.changed?.();
      res.status(204).end();
    }),
  );
  // Reads skip the admission queue (a long apply must not stall thumbnails) but not
  // its gate: no workspace reads while a restore or update may replace them.
  router.get("/assistant-attachments/:file", read, async (req, res) => {
    if (assistants.closed || assistants.recovering || assistants.maintenance)
      throw assistantProblem("unavailable", 503);
    const file = await attachments().content(req.params.file);
    const inline = file.inline === true;
    res
      .set({
        "Content-Type": inline ? file.type : "application/octet-stream",
        "Content-Disposition": inline
          ? "inline"
          : `attachment; filename*=UTF-8''${headerName(file.name)}`,
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, no-store",
      })
      .send(file.body);
  });
  router.use("/assistant-conversations/:id/attachments", (error, _req, _res, next) =>
    next(
      error?.type === "entity.too.large"
        ? assistantProblem("attachmentTooLarge", 413)
        : error,
    ),
  );
  return router;
}
