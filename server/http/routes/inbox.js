import { Router } from "express";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { inboxTypes } from "../../features/inbox/inbox-items.js";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

// The owner's inbox: what waits for a decision, read only. Answers go through each
// source's own endpoint, which also keeps their checks in one place.
export function inboxRoutes({ inbox }) {
  const router = Router();
  router.get("/inbox", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await inbox.snapshot());
  });
  // Counts and revision on every change; clients read GET /inbox again.
  router.get("/inbox/events", async (req, res) => {
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const send = (event) => {
      if (res.writableEnded || res.destroyed) return;
      if (res.writableLength > 1024 * 1024) return res.end();
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.flush?.();
    };
    const unsubscribe = inbox.subscribe(send);
    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
      res.flush?.();
    }, 15000);
    heartbeat.unref();
    const close = () => res.end();
    inbox.events.once("close", close);
    req.on("close", () => {
      unsubscribe();
      clearInterval(heartbeat);
      inbox.events.off("close", close);
    });
    try {
      send({ type: "connected", ...(await inbox.summary()) });
    } catch {
      send({ type: "connected" });
    }
  });
  router.get("/inbox/:type/:id", async (req, res) => {
    const { type, id } = req.params;
    if (!inboxTypes.includes(type) || !idPattern.test(id))
      throw problem(serverMessages.http.notFound, 404);
    res.set("Cache-Control", "no-store");
    res.json(await inbox.status(type, id));
  });
  return router;
}
