import { problem } from "../lib/storage.js";
import { serverMessages } from "../lib/i18n/de.js";
import { principalOf } from "../features/users/identity.js";

/** Socket upgrades are for the owner only until sockets admit users by ownership. */
export function requireOwnerSocket(identity, token) {
  const row = identity.require(token);
  if (principalOf(row).role !== "owner") throw problem(serverMessages.http.notFound, 404);
  return row;
}
