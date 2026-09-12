import crypto from "node:crypto";
import { openQueue } from "./queue.js";

const stores = new Map();

function store(home) {
  let value = stores.get(home);
  if (!value) {
    value = openQueue(home);
    stores.set(home, value);
  }
  return value;
}

export function enqueue(h, key, msg) {
  return store(h).enqueue({ ...msg, to: key });
}

// Zählt und nennt Absender. Liest nur from.name, bewegt nichts.
export function pendingSummary(h, key) {
  return store(h).summary(key);
}

export function claimInbox(h, key, now = Date.now(), leaseMs = 30000) {
  const owner = crypto.randomUUID();
  const claim = store(h).claim(key, owner, now, leaseMs);
  return { ...claim, owner };
}

export function inboxMessageStatus(h, key, id) {
  return store(h).messageStatus(key, id);
}

export function ackInbox(h, owner, claimIds) {
  return store(h).ack(owner, claimIds);
}

/** Compatibility helper for non-MCP callers; MCP callers acknowledge after formatting. */
export function readInbox(h, key) {
  const claim = claimInbox(h, key);
  const count = ackInbox(h, claim.owner, claim.claimIds);
  if (count !== claim.claimIds.length)
    throw new Error("agentbus: inbox acknowledgement failed");
  return claim.rows;
}
