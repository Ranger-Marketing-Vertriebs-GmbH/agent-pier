import { Router } from "express";
import { createHash } from "node:crypto";
import { notFoundBody } from "../responses.js";
import { agentView } from "./me-agents.js";
import { telegramView, userChannel } from "./me-telegram.js";
import { awaitingForUser } from "../../features/users/approval-audience.js";

/**
 * A restricted user's event stream: `agents` when her agent list or one of her main
 * chats changed, `chats` (with `agentId`) when her chat list with an agent changed,
 * `approvals` with the count waiting for her, `account` when her own account changed
 * (the owner turned reading her chats on or off), `telegram` (with `agentId`) when her
 * own agent's bot changed (paired, paused, disconnected), and a heartbeat every 15 s.
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
    const digest = (value) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    // What she sees of her agents, and the approvals waiting for her.
    const read = () => {
      if (!assistants || assistants.closed)
        return {
          list: [],
          count: 0,
          chats: new Set(),
          lists: new Map(),
          bots: new Map(),
        };
      const list = services.userScope
        .agentsFor(userId)
        .map((agent) => agentView(assistants, agent, userId));
      // Only what she can open: an approval of a chat she left is not hers to decide.
      const count = awaitingForUser(services, req.principal).length;
      // Her chat list with each agent, as a digest: only her own chats count.
      const lists = new Map(
        list.map((a) => [a.id, digest(assistants.chats.list(a.id, { userId }))]),
      );
      // Her bot of each agent, as she sees it: pairing finishes in Telegram.
      const bots = new Map(
        list.map((a) => [
          a.id,
          digest(
            telegramView(
              userChannel(assistants, services.assistantChannels, a.id, userId),
            ) ?? null,
          ),
        ]),
      );
      const chats = new Set(list.map((a) => a.conversationId));
      return { list, count, chats, lists, bots };
    };
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
        for (const [agentId, chats] of next.lists)
          if (last.lists.has(agentId) && last.lists.get(agentId) !== chats)
            send({ type: "chats", agentId });
        for (const [agentId, bot] of next.bots)
          if (last.bots.has(agentId) && last.bots.get(agentId) !== bot)
            send({ type: "telegram", agentId });
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
    // The owner turned reading her chats on or off: her notices must say so at once.
    const onPrivacy = (changed) => {
      if (changed === userId) send({ type: "account" });
    };
    services.ownerPrivacy?.on("changed", onPrivacy);
    const end = () => res.end();
    assistants?.events.once("close", end);
    // Opened while agents were off: once they start, the stream ends and her app
    // reconnects to one that follows them.
    const feature = assistants ? null : services.assistantFeature?.events;
    feature?.once("started", end);
    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
      res.flush?.();
    }, 15000);
    heartbeat.unref();
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe?.();
      assistants?.events.off("conversation", onConversation);
      services.ownerPrivacy?.off("changed", onPrivacy);
      assistants?.events.off("close", end);
      feature?.off("started", end);
    });
  });
  return router;
}
