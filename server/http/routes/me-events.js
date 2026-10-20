import { Router } from "express";
import { createHash } from "node:crypto";
import { notFoundBody } from "../responses.js";
import { agentView } from "./me-agents.js";
import { approvalAudience } from "../../features/users/approval-audience.js";

/**
 * A restricted user's event stream: `agents` when her agent list or one of her chats
 * changed, `approvals` with the count waiting for her, and a heartbeat every 15 s.
 * Nothing about other users or the owner passes. Revoking her session ends it (the
 * login check watches every request).
 */
export function meEventRoutes(services) {
  const router = Router();
  router.get("/me/events", (req, res) => {
    if (req.principal?.role !== "user") return res.status(404).json(notFoundBody());
    const { userId } = req.principal;
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const send = (event) => {
      if (res.writableEnded) return;
      if (res.writableLength > 1024 * 1024) return res.end();
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.flush?.();
    };
    const assistants = services.assistants;
    // What she sees of her agents, and the approvals waiting for her.
    const read = () => {
      if (!assistants || assistants.closed)
        return { list: [], count: 0, chats: new Set() };
      const list = services.userScope
        .agentsFor(userId)
        .map((agent) => agentView(assistants, agent, userId));
      const count = (assistants.workflows?.store.awaiting(Date.now()) || []).filter(
        (action) => {
          const audience = approvalAudience(action, assistants.store);
          return audience.kind === "user" && audience.userId === userId;
        },
      ).length;
      return { list, count, chats: new Set(list.map((a) => a.conversationId)) };
    };
    const digest = (value) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    let last = read();
    let lastList = digest(last.list);
    send({ type: "connected" });
    let scheduled = false;
    const check = (force = false) => {
      if (scheduled) return;
      scheduled = true;
      setImmediate(() => {
        scheduled = false;
        let next;
        try {
          next = read();
        } catch {
          return;
        }
        const listDigest = digest(next.list);
        if (force || listDigest !== lastList) send({ type: "agents" });
        if (next.count !== last.count) send({ type: "approvals", count: next.count });
        last = next;
        lastList = listDigest;
      });
    };
    const unsubscribe = assistants?.events.subscribe(() => check());
    // One of her own chats changed (a reply, a reminder's result, an approval).
    const onConversation = (id) => {
      if (last.chats.has(id)) check(true);
    };
    assistants?.events.on("conversation", onConversation);
    const end = () => res.end();
    assistants?.events.once("close", end);
    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
      res.flush?.();
    }, 15000);
    heartbeat.unref();
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe?.();
      assistants?.events.off("conversation", onConversation);
      assistants?.events.off("close", end);
    });
  });
  return router;
}
