// How often one session and one agent may message each other, both directions
// together. A refusal names the window and when to try again.
export const TALK_BUDGET = { pairPerMinute: 6, pairPerTenMinutes: 20 };

const minute = 60_000;
const tenMinutes = 10 * minute;

/** null when the pair may send, else the window it hit and the wait in seconds. */
export function talkBudgetRefusal(
  store,
  { sessionId, assistantId, now = Date.now() },
  limits = TALK_BUDGET,
) {
  const windows = [
    ["minute", minute, limits.pairPerMinute],
    ["ten-minutes", tenMinutes, limits.pairPerTenMinutes],
  ];
  for (const [limit, span, max] of windows) {
    const { count, times } = store.pairCount({
      sessionId,
      assistantId,
      since: now - span,
    });
    if (count >= max)
      return {
        limit,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((times[count - max] + span - now) / 1000),
        ),
      };
  }
  return null;
}

/** One note per pair and 10-minute window in the agent's main chat. */
export function noteLimit(store, row) {
  const at = store.now();
  const id = `limit:${row.sessionId}:${row.assistantId}:${Math.floor(at / tenMinutes)}`;
  if (store.get(id)) return null;
  return store.create({ ...row, id, op: "limit", phase: "noted", createdAt: at });
}
