import { stateOf } from "./hermes-connection.js";

/**
 * The events sub-port (agent-runtime.js) over the supervisor's current client: the
 * run events hermes-run-state.js makes of Hermes's event notifications, and the
 * approvals hermes-approval-queue.js turns into exec approval events. A subscription
 * belongs to one connection: after the host became ready again (a restart) callers
 * subscribe anew. Kinds: `message.start` → started, `message.delta` → text, `tool.*`
 * → tool, `message.complete` → finished, aborted (status interrupted) or failed
 * (status error, `reason` "timeout" or Hermes's failure code), an `error` event of a
 * running turn → failed, any other event of a running turn → progress, the rest →
 * other. `event` and `payload` are Hermes's own (the payload with `sessionKey` and
 * `runId` added).
 */
export function hermesEvents(supervisor) {
  return {
    subscribe(listener) {
      const state = stateOf(supervisor.client);
      if (!state) return () => {};
      return state.runs.subscribe(listener);
    },
  };
}
