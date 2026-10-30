import { MAX_TOPIC_ID } from "../features/live/live-hub.js";
import { notFoundBody } from "./responses.js";

// An agent id in a `me.*` topic id (assistants/live-topics.js AGENT_PARAM).
const agent = "[A-Za-z0-9][A-Za-z0-9_-]{0,99}";
const meTopic = (name, param = false) =>
  new RegExp(`^me\\.${name}${param ? `:${agent}` : ""}$`);

/**
 * Deny-by-default access to the /api routes. A restricted user reaches only the routes
 * listed here, all under /api/me; the owner reaches every other route and none of
 * these. A refusal answers like an unknown route, so it never confirms that a route
 * exists. Every task that adds a /me route adds it here in the same change. A GET
 * route with a `topic` is also pushed as that live topic (live-me-topics.js), whose
 * value is exactly what the route answers her.
 */
export const userRoutes = [
  { method: "GET", pattern: /^\/api\/me$/, topic: meTopic("account") },
  { method: "PUT", pattern: /^\/api\/me\/password$/ },
  { method: "GET", pattern: /^\/api\/me\/dictation$/ },
  // Her own devices for push notices (me-notifications.js).
  { method: "GET", pattern: /^\/api\/me\/notifications$/ },
  { method: "POST", pattern: /^\/api\/me\/notifications\/subscriptions$/ },
  { method: "DELETE", pattern: /^\/api\/me\/notifications\/subscriptions\/[^/]+$/ },
  {
    method: "PUT",
    pattern: /^\/api\/me\/notifications\/subscriptions\/[^/]+\/preferences$/,
  },
  { method: "POST", pattern: /^\/api\/me\/notifications\/(?:presence|test|renew)$/ },
  // Her agents and her own chats with them (me-agents.js, me-conversations.js).
  { method: "GET", pattern: /^\/api\/me\/agents$/, topic: meTopic("agents") },
  { method: "POST", pattern: /^\/api\/me\/agents\/[^/]+\/conversation$/ },
  // Her chat list with each agent, and New chat (me-chats.js).
  {
    method: "GET",
    pattern: /^\/api\/me\/agents\/[^/]+\/chats$/,
    topic: meTopic("chats", true),
  },
  { method: "POST", pattern: /^\/api\/me\/agents\/[^/]+\/chats$/ },
  { method: "PATCH", pattern: /^\/api\/me\/conversations\/[^/]+$/ },
  { method: "DELETE", pattern: /^\/api\/me\/conversations\/[^/]+$/ },
  {
    method: "POST",
    pattern:
      /^\/api\/me\/conversations\/[^/]+\/(?:archive|restore|compact|long-chat-dismissal)$/,
  },
  { method: "GET", pattern: /^\/api\/me\/conversations\/[^/]+\/messages$/ },
  { method: "POST", pattern: /^\/api\/me\/conversations\/[^/]+\/messages$/ },
  { method: "POST", pattern: /^\/api\/me\/conversations\/[^/]+\/queued$/ },
  { method: "DELETE", pattern: /^\/api\/me\/conversations\/[^/]+\/queued$/ },
  { method: "POST", pattern: /^\/api\/me\/attempts\/[^/]+\/(?:cancel|recover)$/ },
  {
    method: "GET",
    pattern: /^\/api\/me\/conversations\/[^/]+\/attachment-policy$/,
  },
  { method: "POST", pattern: /^\/api\/me\/conversations\/[^/]+\/attachments$/ },
  {
    method: "GET",
    pattern: /^\/api\/me\/conversations\/[^/]+\/attachments\/[^/]+$/,
  },
  {
    method: "DELETE",
    pattern: /^\/api\/me\/conversations\/[^/]+\/attachments\/[^/]+$/,
  },
  { method: "GET", pattern: /^\/api\/me\/attachments\/[^/]+$/ },
  // Her agent's browser: running, and watchable now (me-agents.js).
  { method: "GET", pattern: /^\/api\/me\/agents\/[^/]+\/browser$/ },
  // Her agents' settings and memory within her level (me-agent-settings.js).
  { method: "GET", pattern: /^\/api\/me\/agents\/[^/]+\/settings$/ },
  { method: "PATCH", pattern: /^\/api\/me\/agents\/[^/]+\/settings$/ },
  { method: "GET", pattern: /^\/api\/me\/agents\/[^/]+\/memory$/ },
  { method: "GET", pattern: /^\/api\/me\/agents\/[^/]+\/memory\/[^/]+$/ },
  { method: "DELETE", pattern: /^\/api\/me\/agents\/[^/]+\/memory\/[^/]+$/ },
  // The approvals of her own chats (me-approvals.js).
  { method: "GET", pattern: /^\/api\/me\/approvals$/, topic: meTopic("approvals") },
  { method: "POST", pattern: /^\/api\/me\/approvals\/[^/]+\/decision$/ },
  // Her own agent's Telegram bot at "extended" (me-telegram.js).
  {
    method: "GET",
    pattern: /^\/api\/me\/agents\/[^/]+\/telegram$/,
    topic: meTopic("telegram", true),
  },
  { method: "PUT", pattern: /^\/api\/me\/agents\/[^/]+\/telegram$/ },
  { method: "POST", pattern: /^\/api\/me\/agents\/[^/]+\/telegram\/pair$/ },
  { method: "DELETE", pattern: /^\/api\/me\/agents\/[^/]+\/telegram$/ },
  // Her own reminders and routines on her agents (me-reminders.js).
  {
    method: "GET",
    pattern: /^\/api\/me\/agents\/[^/]+\/reminders$/,
    topic: meTopic("reminders", true),
  },
  { method: "GET", pattern: /^\/api\/me\/agents\/[^/]+\/routines$/ },
  { method: "POST", pattern: /^\/api\/me\/agents\/[^/]+\/(?:reminders|routines)$/ },
  {
    method: "PATCH",
    pattern: /^\/api\/me\/agents\/[^/]+\/(?:reminders|routines)\/[^/]+$/,
  },
  {
    method: "DELETE",
    pattern: /^\/api\/me\/agents\/[^/]+\/(?:reminders|routines)\/[^/]+$/,
  },
  {
    method: "GET",
    pattern: /^\/api\/me\/conversations\/[^/]+\/shared-files\/[^/]+$/,
  },
];

/**
 * Deny-by-default access to live topics (live-hub.js): a restricted user subscribes
 * only to topic ids matched here, all `me.*`, each the `topic` of its /me route
 * above; every other topic answers her like an unknown one. Every task that adds a
 * `me.*` topic adds it to its route in the same change.
 */
export const userTopics = Object.freeze(
  userRoutes.filter((route) => route.topic).map((route) => route.topic),
);

/** Whether a restricted user may subscribe to the live topic `topicId`. */
export function userMayWatch(topicId, topics = userTopics) {
  if (typeof topicId !== "string" || topicId.length > MAX_TOPIC_ID) return false;
  return topics.some((pattern) => pattern.test(topicId));
}

const userSpace = /^\/api\/me(?:\/|$)/;
// Dot segments, plain or percent-encoded, never name a user route.
const dotSegment = /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i;

/** Whether a restricted user may send `method` to the raw request `path`. */
export function userMayReach(method, path) {
  if (typeof path !== "string" || dotSegment.test(path)) return false;
  const verb = method === "HEAD" ? "GET" : method;
  return userRoutes.some((route) => route.method === verb && route.pattern.test(path));
}

/** Mounted on /api right after the login check. */
export function routeAccess() {
  return (req, res, next) => {
    const path = `${req.baseUrl}${req.path}`;
    const allowed =
      req.principal?.role === "user"
        ? userMayReach(req.method, path)
        : !userSpace.test(path);
    if (allowed) return next();
    res.status(404).json(notFoundBody());
  };
}
