import { setTimeout as delay } from "node:timers/promises";
import { sessionCreateTimeoutMs } from "./gateway-client.js";

// OpenClaw 2026.10.3 bounds sessions.create's wait for its model catalog to 20 s
// (two thirds of its 30 s request timeout) and then answers UNAVAILABLE with
// `retryable: true`: the session was not created. Such an answer is retried after a
// short pause; a retry with less room left than that wait could only end in an
// ambiguous timeout, so the answer is passed on instead.
const pausesMs = [500, 1000, 2000];
const minAttemptMs = 25000;

// OpenClaw (2026.9.9 and 2026.10.3) also refuses sessions.create, without
// `retryable`, with SessionMutationFactsUnavailableError ("Session access facts are
// unavailable; retry after session storage is ready."): it could not prepare or keep
// the new session's access facts (2026.10.3: session-sharing-preparation-BV_Zvhax.mjs).
// For a create without parent, fork or initial turn, as AgentPier sends it, the error
// comes while the target is prepared or from guards that run before the entry
// commits, inside its write transaction; seconds later the same call succeeds. Were
// it ever raised after the commit, the label claimed in that transaction would still
// refuse a second session with the same label.
const storageNotReady = "SessionMutationFactsUnavailableError";

/** Whether the Gateway answered that it created no session and may be asked again. */
export const sessionNotCreated = (error) =>
  error?.answered === true &&
  error.code === "UNAVAILABLE" &&
  (error.retryable === true || error.remoteError === storageNotReady);

/**
 * sessions.create within `budgetMs` (the cold-start timeout), retrying only answers
 * that prove no session exists. Every other failure is passed on at once.
 */
export async function createGatewaySession(
  client,
  params,
  { budgetMs = sessionCreateTimeoutMs, now = Date.now, sleep = delay } = {},
) {
  const deadline = now() + budgetMs;
  let timeoutMs = budgetMs;
  for (const pause of [...pausesMs, null]) {
    try {
      return await client.call("sessions.create", params, { timeoutMs });
    } catch (error) {
      if (pause === null || !sessionNotCreated(error)) throw error;
      if (deadline - now() - pause < minAttemptMs) throw error;
      await sleep(pause);
      timeoutMs = deadline - now();
    }
  }
}
