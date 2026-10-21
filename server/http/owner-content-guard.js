import { notFoundBody } from "./responses.js";
import { ownerContentRoutes } from "./owner-content-routes.js";

// "GET /api/assistants/:id/memory" → method and a pattern whose group is the first param.
const compiled = Object.entries(ownerContentRoutes).map(([key, kind]) => {
  const [method, path] = key.split(" ");
  let first = true;
  const source = path
    .split("/")
    .map((part) => {
      if (!part.startsWith(":")) return part.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
      const group = first ? "([^/]+)" : "[^/]+";
      first = false;
      return group;
    })
    .join("/");
  return { method, pattern: new RegExp(`^${source}$`, "i"), kind };
});

const reading = (method) => ["GET", "HEAD"].includes(method);

/**
 * The owner's privacy guard (owner-privacy.js), mounted after the route access check.
 * Each content route's parameter is resolved to its conversation or agent; what the
 * owner may not read answers like an unknown route. He reads a user's chat only under
 * her opt-in and from its `since` (passed on as `res.locals.privacySince`), and never
 * writes into it, decides its approvals or re-pairs her channel.
 */
export function ownerContentGuard(services) {
  // The stored record, a deleted chat's too: what is left of one is nobody's to read.
  const resolve = {
    conversation: (a, id) => a.store.storedConversation(id),
    attempt: (a, id) =>
      a.store.storedConversation(
        a.ledger.getRequest(a.ledger.getAttempt(id).requestId).conversationId,
      ),
    attachment: (a, id) => {
      const conversationId = a.attachments.conversationOf(id);
      return conversationId ? a.store.storedConversation(conversationId) : null;
    },
    action: (a, id) => {
      const action = a.workflows?.store.get(id);
      return action?.conversationId
        ? a.store.storedConversation(action.conversationId)
        : null;
    },
  };
  // The request a chat file came with or answers; a lost one counts as unknown.
  function requestOf(assistants, id) {
    const requestId = assistants.attachments.requestOf?.(id);
    try {
      return requestId ? assistants.ledger.getRequest(requestId) : null;
    } catch {
      return null;
    }
  }
  // Whether the owner may use this route on this target; `since` limits a read.
  function decide(assistants, privacy, { kind, method }, id, res) {
    // A write over every chat of an agent (clearing its attachments) would delete what
    // its users wrote: only an agent no user chats with may be cleared.
    if (kind === "agentChats") return !assistants.store.getAssistant(id).userAccess;
    if (kind === "agent" || kind === "channel") {
      const channel =
        kind === "channel" ? services.assistantChannels?.store.get(id) : null;
      const agentId = kind === "agent" ? id : channel?.assistantId;
      if (!agentId) return true;
      const agent = assistants.store.getAssistant(agentId);
      if (!privacy.agentContent(agent)) return false;
      // A user's own agent is hers: under the opt-in the owner reads, never changes.
      const own = agent.userAccess?.mode === "own";
      if (own && !reading(method)) return false;
      if (kind === "agent" || reading(method)) return true;
      // A user's bot delivers into her chat; only she pairs it. The owner's bot on a
      // shared agent delivers into his own chat and stays his to pair and remove.
      return (
        typeof assistants.store.getConversation(channel.conversationId).userId !==
        "string"
      );
    }
    const conversation = resolve[kind](assistants, id);
    if (!conversation) return true;
    // A deleted chat answers 404 on every route; its leftover files never serve.
    if (conversation.deletedAt) return false;
    if (typeof conversation.userId !== "string") {
      // His chat from when the agent was shared: once it is a user's own agent, he
      // reads what he wrote but no longer chats with it (conversation-turns.js).
      const agent = assistants.store.getAssistant(conversation.assistantId);
      return reading(method) || agent.userAccess?.mode !== "own";
    }
    // Her turns, approvals and uploads are hers alone, opt-in or not.
    if (kind === "action" || kind === "attempt" || !reading(method)) return false;
    const { readable, since } = privacy.conversation(conversation);
    // A file from before the opt-in stays hers, like the messages it came with.
    if (kind === "attachment" && readable)
      return privacy.fileVisible(
        assistants.attachments.createdAt(id),
        since,
        requestOf(assistants, id),
      );
    if (readable) res.locals.privacySince = since;
    return readable;
  }
  return (req, res, next) => {
    const assistants = services.assistants;
    const privacy = services.ownerPrivacy;
    if (req.principal?.role !== "owner" || !assistants || !privacy) return next();
    // Express routes are case-insensitive and non-strict: `/x/messages/` and
    // `/X/Messages` reach the route `/x/messages`, so they must reach the guard too.
    const path = `${req.baseUrl}${req.path}`.replace(/\/+$/, "");
    const method = req.method === "HEAD" ? "GET" : req.method;
    const route = compiled.find((r) => r.method === method && r.pattern.test(path));
    if (!route) return next();
    let allowed;
    try {
      allowed = decide(
        assistants,
        privacy,
        route,
        decodeURIComponent(route.pattern.exec(path)[1]),
        res,
      );
    } catch {
      // An unknown target is the route's own 404 to give.
      return next();
    }
    if (allowed) return next();
    res.status(404).json(notFoundBody());
  };
}
