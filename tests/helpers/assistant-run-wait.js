import { setTimeout as delay } from "node:timers/promises";
import { terminalState } from "../../server/features/assistants/run-reconciler.js";
import { contractTimeout } from "./contract-timeout.js";

/**
 * Waits on the pinned Gateway until a run has ended, as AgentPier's reconciler reads
 * it (run-reconciler.js terminalState), and returns the last `agent.wait` answer.
 * OpenClaw 2026.11.6 queues a turn sent while its session still has work (an exec
 * completion's run just ending, for example) and then answers `agent.wait` at once
 * with `{ status: "pending", timeoutPhase: "queue" }`: the run has not started yet.
 * Each answer that is not terminal is asked again until `timeoutMs` has passed.
 */
export async function waitForRun(client, runId, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + contractTimeout(timeoutMs);
  for (;;) {
    const left = Math.max(1, deadline - Date.now());
    const waited = await client.call(
      "agent.wait",
      { runId, timeoutMs: left },
      { timeoutMs: left + 5000 },
    );
    if (terminalState(waited) || Date.now() >= deadline) return waited;
    // A queued run's answer comes at once; a timed out wait has used its time.
    if (waited?.status === "pending") await delay(200);
  }
}
