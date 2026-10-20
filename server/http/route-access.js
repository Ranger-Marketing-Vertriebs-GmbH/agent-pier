import { notFoundBody } from "./responses.js";

/**
 * Deny-by-default access to the /api routes. A restricted user reaches only the routes
 * listed here, all under /api/me; the owner reaches every other route and none of
 * these. A refusal answers like an unknown route, so it never confirms that a route
 * exists. Every task that adds a /me route adds it here in the same change.
 */
export const userRoutes = [
  { method: "GET", pattern: /^\/api\/me$/ },
  { method: "PUT", pattern: /^\/api\/me\/password$/ },
  { method: "GET", pattern: /^\/api\/me\/dictation$/ },
  // Her event stream (me-events.js).
  { method: "GET", pattern: /^\/api\/me\/events$/ },
  // Her own devices for push notices (me-notifications.js).
  { method: "GET", pattern: /^\/api\/me\/notifications$/ },
  { method: "POST", pattern: /^\/api\/me\/notifications\/subscriptions$/ },
  { method: "DELETE", pattern: /^\/api\/me\/notifications\/subscriptions\/[^/]+$/ },
  {
    method: "PUT",
    pattern: /^\/api\/me\/notifications\/subscriptions\/[^/]+\/preferences$/,
  },
  { method: "POST", pattern: /^\/api\/me\/notifications\/(?:presence|test)$/ },
  // Her agents and her own chats with them (me-agents.js, me-conversations.js).
  { method: "GET", pattern: /^\/api\/me\/agents$/ },
  { method: "POST", pattern: /^\/api\/me\/agents\/[^/]+\/conversation$/ },
  // Her chat list with each agent, and New chat (me-chats.js).
  { method: "GET", pattern: /^\/api\/me\/agents\/[^/]+\/chats$/ },
  { method: "POST", pattern: /^\/api\/me\/agents\/[^/]+\/chats$/ },
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
  { method: "GET", pattern: /^\/api\/me\/approvals$/ },
  { method: "POST", pattern: /^\/api\/me\/approvals\/[^/]+\/decision$/ },
  // Her own agent's Telegram bot at "extended" (me-telegram.js).
  { method: "GET", pattern: /^\/api\/me\/agents\/[^/]+\/telegram$/ },
  { method: "PUT", pattern: /^\/api\/me\/agents\/[^/]+\/telegram$/ },
  { method: "POST", pattern: /^\/api\/me\/agents\/[^/]+\/telegram\/pair$/ },
  { method: "DELETE", pattern: /^\/api\/me\/agents\/[^/]+\/telegram$/ },
  // Her own reminders and routines on her agents (me-reminders.js).
  { method: "GET", pattern: /^\/api\/me\/agents\/[^/]+\/(?:reminders|routines)$/ },
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
