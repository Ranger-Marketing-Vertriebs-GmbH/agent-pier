import { setImmediate as tick } from "node:timers/promises";
import { createHermesClient } from "../../server/features/assistants/runtimes/hermes/hermes-connection.js";
import { hermesSessions } from "../../server/features/assistants/runtimes/hermes/hermes-sessions.js";
import { hermesEvents } from "../../server/features/assistants/runtimes/hermes/hermes-events.js";
import { hermesApprovals } from "../../server/features/assistants/runtimes/hermes/hermes-approvals.js";
import { memoryTransport } from "./hermes-fake-gateway.js";

// A Hermes client of agent-1 over a scripted gateway, for the adapter's unit tests
// (tests/unit/hermes-adapter.test.js, hermes-approval-queue.test.js).

export const agentId = "agent-1";

export const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await tick();
};

/** An event frame of session `sid`; `extra` adds envelope fields (seq, admission_id). */
export const event = (type, sid, payload = {}, extra = {}) => ({
  jsonrpc: "2.0",
  method: "event",
  params: { type, session_id: sid, payload, ...extra },
});

/** A refusal as the gateway's session store answers it (an `answer` of scripted). */
export const refusal = (reason, data = {}) => ({
  error: { code: 4001, message: reason, data: { reason, ...data } },
});

/**
 * A connected client over a peer that answers with `answer(frame)`: a result, an
 * `{ error }` or undefined (no answer). The sub-ports read it as the supervisor's.
 */
export async function scripted(answer = () => ({})) {
  const { transport, peer } = memoryTransport();
  const client = createHermesClient(transport, { agentId, timeoutMs: 50 });
  peer.on("frame", (frame) => {
    if (typeof frame.method !== "string") return;
    if (frame.method === "client.capabilities")
      return peer.send({ jsonrpc: "2.0", id: frame.id, result: {} });
    const out = answer(frame);
    if (out === undefined) return;
    peer.send({ jsonrpc: "2.0", id: frame.id, ...(out.error ? out : { result: out }) });
  });
  peer.send(event("gateway.ready"));
  await client.connect({ timeoutMs: 1000 });
  const supervisor = { client, agentId };
  return {
    client,
    peer,
    supervisor,
    sessions: hermesSessions(supervisor),
    events: hermesEvents(supervisor),
    approvals: hermesApprovals(supervisor),
  };
}
