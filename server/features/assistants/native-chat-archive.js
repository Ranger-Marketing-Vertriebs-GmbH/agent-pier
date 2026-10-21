// OpenClaw's own session maintenance can archive an AgentPier chat's native session:
// `pruneAfter` (30 idle days by default) archives every ordinary durable session with
// reason `age-retention`, `maxEntries` archives the oldest beyond its cap, and SQLite
// recovery can archive with `restart-recovery`. A natively archived session refuses
// every turn and every routine, reminder or check-in commit into it, while its
// transcript stays. A pinned session is exempt from all automatic maintenance, so
// AgentPier pins each chat it keeps and reopens one OpenClaw archived anyway
// (`sessions.patch` restores it with its history). AgentPier's own archive never
// archives natively (agent-chats.js); deleted and released chats are not reconciled.

/**
 * Keeps one chat's native session open: an archived session is restored and pinned in
 * one `sessions.patch`, an open one is pinned. Answers "reopened", "pinned", "open", or
 * "missing" when the Gateway reports no session for the key.
 */
export async function keepChatOpen(client, key) {
  const { session } = (await client.call("sessions.describe", { key })) || {};
  if (!session?.sessionId) return "missing";
  if (session.archived) {
    await client.call("sessions.patch", {
      key,
      archived: false,
      pinned: true,
      expectedSessionId: session.sessionId,
    });
    return "reopened";
  }
  if (session.pinned) return "open";
  await client.call("sessions.patch", {
    key,
    pinned: true,
    expectedSessionId: session.sessionId,
  });
  return "pinned";
}

/**
 * After the Gateway refused a turn (`INVALID_REQUEST`), reopens the chat's session if
 * OpenClaw archived it. True only when it did: the refusal came before any run
 * started, so the caller sends the same turn again.
 */
export async function reopenRefusedChat(client, key, error) {
  if (error?.code !== "INVALID_REQUEST") return false;
  try {
    return (await keepChatOpen(client, key)) === "reopened";
  } catch {
    return false;
  }
}
