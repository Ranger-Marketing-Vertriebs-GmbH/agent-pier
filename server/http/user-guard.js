import { problem } from "../lib/storage.js";
import { serverMessages } from "../lib/i18n/de.js";
import { principalOf } from "../features/users/identity.js";
import { notFoundBody } from "./responses.js";

const userPath = (path) => path === "/me" || path.startsWith("/me/");

/**
 * Fail-closed guard for restricted users, mounted on /api right after the login check:
 * a user reaches only /api/me and its subpaths, the owner never reaches them. Every
 * refusal looks like an unknown route, so it never confirms that a route exists.
 */
export function userGuard() {
  return (req, res, next) => {
    const user = req.principal?.role === "user";
    if (user === userPath(req.path)) return next();
    res.status(404).json(notFoundBody());
  };
}

/** Socket upgrades are for the owner only until sockets admit users by ownership. */
export function requireOwnerSocket(identity, token) {
  const row = identity.require(token);
  if (principalOf(row).role !== "owner") throw problem(serverMessages.http.notFound, 404);
  return row;
}
