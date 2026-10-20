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
