import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { notFoundBody } from "../responses.js";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { assistantActivity } from "../../features/assistants/assistant-activity.js";
import { isShared, memberLevel } from "../../features/users/user-access.js";
import { mainConversation } from "../../features/assistants/routine-targets.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { meConversationRoutes } from "./me-conversations.js";
import { meAgentSettingsRoutes } from "./me-agent-settings.js";

// The /api/me routes that read or change agent data; each exists only while the
// agent services do. Every handler asks the user scope (user-scope.js) first.
const agentSpace = /^\/me\/(?:agents|conversations|attempts|attachments)(?:\/|$)/;

/** Per-user budgets for chat files, apart from the owner's and every other user's. */
function userLimits() {
  const limited = (limit) =>
    rateLimit({
      windowMs: 60_000,
      limit,
      keyGenerator: (req) => `user:${req.principal?.userId}`,
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
  return { uploadLimit: limited(60), readLimit: limited(600) };
}

/** A user's agent as her list shows it, with her own main chat. */
export function agentView(assistants, agent, userId) {
  const conversation = mainConversation(assistants.store, agent.id, userId);
  const activity = assistantActivity({
    assistants: [agent],
    conversations: conversation ? [conversation] : [],
    latest: conversation
      ? assistants.ledger
          .latestByConversation()
          .filter((row) => row.conversationId === conversation.id)
      : [],
  });
  const { state, reason, label } = activity[agent.id];
  return {
    id: agent.id,
    name: agent.name,
    avatar: agent.avatar ?? null,
    shared: isShared(agent),
    level: memberLevel(agent, userId),
    conversationId: conversation?.id ?? null,
    activity: { state, reason, label },
  };
}

function activeRoutes(services, limits) {
  const { assistants, userScope } = services;
  const router = Router();
  router.get("/me/agents", (req, res) =>
    res.json(
      userScope
        .agentsFor(req.principal.userId)
        .map((agent) => agentView(assistants, agent, req.principal.userId)),
    ),
  );
  router.post("/me/agents/:id/conversation", async (req, res) => {
    const agent = userScope.agentOf(req.principal, req.params.id);
    const conversation = await assistants.openConversation(agent.id, {
      userId: req.principal.userId,
    });
    res.json({ id: conversation.id });
  });
  router.use(meConversationRoutes(services, limits));
  router.use(meAgentSettingsRoutes(services));
  return router;
}

/**
 * A restricted user's agents and chats. Without the agent feature she has no agents
 * and every other agent route is unknown; the owner never reaches these routes.
 */
export function meAgentRoutes(services) {
  const router = Router();
  const limits = userLimits();
  let built = null;
  let routes = null;
  const current = () => {
    if (built !== services.assistants) {
      routes = activeRoutes(services, limits);
      built = services.assistants;
    }
    return routes;
  };
  router.use((req, res, next) => {
    if (!agentSpace.test(req.path)) return next();
    if (req.principal?.role !== "user") return res.status(404).json(notFoundBody());
    if (!services.assistants) {
      if (req.method === "GET" && req.path === "/me/agents") return res.json([]);
      if (!services.assistantFeature?.enabled)
        return res.status(404).json(notFoundBody());
      return next(assistantProblem("unavailable", 503));
    }
    return current()(req, res, next);
  });
  router.inventory = () => (services.assistants ? [current()] : []);
  return router;
}
