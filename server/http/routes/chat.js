import { Router, raw } from "express";
import { ChatSync } from "../../features/chat/chat-sync.js";

export function chatRoutes(services) {
  const { chatImages, chatAttachments, chat } = services;
  const sync = new ChatSync(services);
  const router = Router();
  router.post(
    "/sessions/:id/chat/attachments",
    raw({ type: "application/octet-stream", limit: "10mb" }),
    async (req, res, next) => {
      if (!req.is("application/octet-stream")) return next();
      res
        .status(201)
        .json(
          await services.chatAttachments.save(req.params.id, req.query.name, req.body),
        );
    },
  );
  router.get("/sessions/:id/chat", async (req, res) =>
    res.json(await sync.read(req.params.id, req.query.cursor)),
  );
  router.get("/sessions/:id/chat/images/:imageId", async (req, res) => {
    const image = await chatImages.file(req.params.id, req.params.imageId);
    res
      .set({
        "Content-Type": image.type,
        "Content-Disposition": "inline",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      })
      .send(image.body);
  });
  router.get("/sessions/:id/chat/choices", async (req, res) =>
    res.json({ choices: await chat.choices(req.params.id) }),
  );
  router.post("/sessions/:id/chat/bind", async (req, res) =>
    res.json(
      await chatImages.decorate(
        req.params.id,
        await chat.bind(req.params.id, req.body?.providerSessionId),
      ),
    ),
  );
  router.post("/sessions/:id/chat/attachments", async (req, res) =>
    res.status(201).json(await chatAttachments.store(req.params.id, req.body)),
  );
  return router;
}
