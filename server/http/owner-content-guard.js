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
  return { method, pattern: new RegExp(`^${source}$`), kind };
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
  const resolve = {
    conversation: (a, id) => a.store.getConversation(id),
    attempt: (a, id) =>
      a.store.getConversation(
        a.ledger.getRequest(a.ledger.getAttempt(id).requestId).conversationId,
      ),
    attachment: (a, id) => {
      const conversationId = a.attachments.conversationOf(id);
      return conversationId ? a.store.getConversation(conversationId) : null;
    },
    action: (a, id) => {
      const action = a.workflows?.store.get(id);
      return action?.conversationId
        ? a.store.getConversation(action.conversationId)
        : null;
    },
  };
  // Whether the owner may use this route on this target; `since` limits a read.
  function decide(assistants, privacy, { kind, method }, id, res) {
    if (kind === "agent" || kind === "channel") {
      const agentId =
        kind === "agent" ? id : services.assistantChannels?.store.get(id)?.assistantId;
      if (!agentId) return true;
      const agent = assistants.store.getAssistant(agentId);
      if (!privacy.agentContent(agent)) return false;
      // A user's own agent is hers: under the opt-in the owner reads, never changes.
      const own = agent.userAccess?.mode === "own";
      if (own && !reading(method)) return false;
      // Her agent's channel delivers into her chat; only she pairs it.
      return !(kind === "channel" && agent.userAccess && !reading(method));
    }
    const conversation = resolve[kind](assistants, id);
    if (!conversation || typeof conversation.userId !== "string") return true;
    // Her turns, approvals and uploads are hers alone, opt-in or not.
    if (kind === "action" || kind === "attempt" || !reading(method)) return false;
    const { readable, since } = privacy.conversation(conversation);
    if (readable) res.locals.privacySince = since;
    return readable;
  }
  return (req, res, next) => {
    const assistants = services.assistants;
    const privacy = services.ownerPrivacy;
    if (req.principal?.role !== "owner" || !assistants || !privacy) return next();
    const path = `${req.baseUrl}${req.path}`;
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
