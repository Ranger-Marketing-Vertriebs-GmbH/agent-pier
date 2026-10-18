import { Router, raw } from "express";
import { rateLimit } from "express-rate-limit";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { MAX_ATTACHMENT_BYTES } from "../../features/assistants/agent-attachment-types.js";
import { VIDEO_HEAD_BYTES } from "../../features/assistants/agent-video-types.js";
import { sendFileRange } from "../byte-ranges.js";
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
  // A video arrives in up to 25 chunks of its own.
  return {
    attachmentUploadLimit: limited(60),
    attachmentReadLimit: limited(600),
    attachmentChunkLimit: limited(600),
  };
}

const headerName = (name) =>
  encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
// The raw body may exceed the file limit slightly so the route answers with its own
// translated error; anything larger fails in the parser and is translated below.
const body = raw({ type: "application/octet-stream", limit: MAX_ATTACHMENT_BYTES + 1 });

// The first bytes of a streamed body, and the whole body as chunks again.
async function headOf(req, length) {
  const source = req[Symbol.asyncIterator]();
  const parts = [];
  let size = 0;
  let done = false;
  while (size < length) {
    const next = await source.next();
    if (next.done) {
      done = true;
      break;
    }
    parts.push(next.value);
    size += next.value.length;
  }
  const head = Buffer.concat(parts);
  async function* chunks() {
    if (head.length) yield head;
    if (done) return;
    for (let next = await source.next(); !next.done; next = await source.next())
      yield next.value;
  }
  return { head: head.subarray(0, length), chunks: chunks() };
}
const integer = (value) => (/^\d{1,12}$/.test(String(value ?? "")) ? Number(value) : NaN);

/** Owner routes, behind the login: stage, discard and show chat attachments. */
export function assistantAttachmentRoutes({
  assistants,
  attachmentUploadLimit: upload = assistantAttachmentRateLimits().attachmentUploadLimit,
  attachmentReadLimit: read = assistantAttachmentRateLimits().attachmentReadLimit,
  attachmentChunkLimit: chunk = assistantAttachmentRateLimits().attachmentChunkLimit,
}) {
  const router = Router();
  const attachments = () => assistants.attachments;
  const gate = () => {
    if (assistants.closed || assistants.recovering || assistants.maintenance)
      throw assistantProblem("unavailable", 503);
  };
  // Writes one video chunk outside the admission queue (a phone may take minutes),
  // and stages the video through it once the last byte is in.
  const receive = async (req, res, upload, offset, chunks) => {
    gate();
    const videos = attachments().videos;
    let state;
    try {
      state = await videos.receive(req.params.id, upload, offset, chunks);
    } catch (error) {
      if (error.received === undefined) throw error;
      const message = error.message;
      return res
        .status(409)
        .json({ error: message, ...messageIdentity(message), received: error.received });
    }
    if (state.file) return res.status(201).json(state.file);
    if (!state.complete)
      return res.status(offset ? 200 : 201).json({ upload, received: state.received });
    res
      .status(201)
      .json(await assistants.admit(() => videos.finish(req.params.id, upload)));
  };
  // Videos: the first chunk names the file and its full size.
  router.post("/assistant-conversations/:id/video-uploads", upload, async (req, res) => {
    if (!req.is("application/octet-stream")) throw assistantProblem("invalid", 415);
    const { head, chunks } = await headOf(req, VIDEO_HEAD_BYTES);
    const started = await assistants.admit(() =>
      attachments().videos.begin(
        req.params.id,
        req.query.name,
        integer(req.query.size),
        head,
        req.query.upload,
      ),
    );
    // The reply to an earlier try of this request was lost; the video is staged.
    if (started.file) return res.status(201).json(started.file);
    try {
      await receive(req, res, started.upload, 0, chunks);
    } catch (error) {
      // A first chunk that failed leaves nothing to continue.
      await attachments()
        .videos.cancel(req.params.id, started.upload)
        .catch(() => {});
      throw error;
    }
  });
  router.put(
    "/assistant-conversations/:id/video-uploads/:upload",
    chunk,
    async (req, res) => {
      if (!req.is("application/octet-stream")) throw assistantProblem("invalid", 415);
      const offset = integer(req.query.offset);
      if (!Number.isSafeInteger(offset)) throw assistantProblem("invalid");
      await receive(req, res, req.params.upload, offset, req);
    },
  );
  router.delete(
    "/assistant-conversations/:id/video-uploads/:upload",
    upload,
    (req, res) =>
      assistants.admit(async () => {
        await attachments().videos.cancel(req.params.id, req.params.upload);
        res.status(204).end();
      }),
  );
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
  // The owner's view of an agent's attachments folder against its limits, and
  // clearing it (agent-attachments.js clear), audited with what it removed.
  router.get("/assistants/:id/attachment-usage", read, async (req, res) => {
    gate();
    res.json(await attachments().usage(req.params.id));
  });
  router.delete("/assistants/:id/attachments", upload, (req, res) =>
    assistants.admit(async () => {
      const removed = await attachments().clear(req.params.id);
      try {
        assistants.audit?.append({
          action: "assistant.updated",
          resourceType: "assistant",
          resourceId: req.params.id,
          source: "user",
          outcome: "success",
          details: {
            kind: "attachment-clear",
            count: removed.files,
            bytes: removed.bytes,
          },
        });
      } catch (error) {
        console.error("Attachment clear audit failed:", error?.message);
      }
      assistants.changed?.();
      res.json(await attachments().usage(req.params.id));
    }),
  );
  // Reads skip the admission queue (a long apply must not stall thumbnails) but not
  // its gate: no workspace reads while a restore or update may replace them.
  router.get("/assistant-attachments/:file", read, async (req, res) => {
    gate();
    const file = await attachments().serve(req.params.file);
    const inline = file.inline === true;
    res.set({
      "Content-Type": inline ? file.type : "application/octet-stream",
      "Content-Disposition": inline
        ? "inline"
        : `attachment; filename*=UTF-8''${headerName(file.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    });
    // A video plays from its open, verified copy, a byte range at a time.
    if (file.handle) return sendFileRange(req, res, file);
    res.send(file.body);
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
