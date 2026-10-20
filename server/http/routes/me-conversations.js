import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import {
  attachmentBody,
  attachmentTooLarge,
  sendAttachment,
} from "./assistant-attachments.js";

const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
// A user's turn never starts team work; the flag is not hers to send.
const withoutTeam = (body) => {
  if (!record(body)) return body;
  const { teamAllowed: _team, ...rest } = body;
  return rest;
};

/**
 * A user's own chats: messages, the queued message, attachments and the files her
 * agent shared. Each handler resolves its conversation through the user scope first,
 * so another user's or the owner's chat is the unknown-route 404.
 */
export function meConversationRoutes(
  { assistants, userScope },
  { uploadLimit, readLimit },
) {
  const router = Router();
  const own = (req) => userScope.conversationOf(req.principal, req.params.id);
  const gate = () => {
    if (assistants.closed || assistants.recovering || assistants.maintenance)
      throw assistantProblem("unavailable", 503);
  };
  router.get("/me/conversations/:id/messages", async (req, res) => {
    const { id } = own(req);
    res.json(
      typeof req.query.cursor === "string" && req.query.before === undefined
        ? await assistants.feeds.snapshot(id, req.query.cursor)
        : await assistants.history(id, {
            before: req.query.before,
            limit: req.query.limit ? Number(req.query.limit) : 100,
          }),
    );
  });
  router.post("/me/conversations/:id/messages", async (req, res) => {
    const { id } = own(req);
    const context = { kind: "user", userId: req.principal.userId };
    res.status(202).json(await assistants.send(id, withoutTeam(req.body), context));
  });
  router.post("/me/conversations/:id/queued", (req, res) =>
    res.json(assistants.queue(own(req).id, withoutTeam(req.body))),
  );
  router.delete("/me/conversations/:id/queued", (req, res) =>
    res.json(assistants.takeBackQueued(own(req).id)),
  );
  router.post("/me/attempts/:id/cancel", async (req, res) => {
    userScope.attemptOf(req.principal, req.params.id);
    res.json(await assistants.cancel(req.params.id));
  });
  router.get("/me/conversations/:id/attachment-policy", readLimit, (req, res) =>
    res.json(assistants.attachments.policy(own(req).id)),
  );
  router.post(
    "/me/conversations/:id/attachments",
    uploadLimit,
    (req, _res, next) => {
      // Ownership before the body: another user's chat never reads an upload.
      own(req);
      next();
    },
    attachmentBody,
    (req, res) =>
      assistants.admit(async () => {
        const { id } = own(req);
        if (!req.is("application/octet-stream")) throw assistantProblem("invalid", 415);
        res
          .status(201)
          .json(await assistants.attachments.stage(id, req.query.name, req.body));
      }),
  );
  router.use("/me/conversations/:id/attachments", attachmentTooLarge);
  router.delete("/me/conversations/:id/attachments/:file", uploadLimit, (req, res) =>
    assistants.admit(async () => {
      const { id } = own(req);
      if (userScope.attachmentOf(req.principal, req.params.file).id !== id)
        throw userScope.refusal();
      await assistants.attachments.discard(id, req.params.file);
      res.status(204).end();
    }),
  );
  router.get("/me/attachments/:file", readLimit, async (req, res) => {
    gate();
    userScope.attachmentOf(req.principal, req.params.file);
    sendAttachment(req, res, await assistants.attachments.serve(req.params.file));
  });
  router.get("/me/conversations/:id/shared-files/:file", readLimit, async (req, res) => {
    gate();
    const { id } = own(req);
    if (userScope.attachmentOf(req.principal, req.params.file).id !== id)
      throw userScope.refusal();
    sendAttachment(req, res, await assistants.attachments.serve(req.params.file));
  });
  return router;
}
