// The live `connections.problems` topic: the entries of Zugänge with problems, the
// value GET /api/connections/problems answers. It reads stored state only (no test,
// token check or sign-in probe). The owner's successful writes and agents switched
// on or off signal it; the parts that change without either (stored test results,
// MCP installs, token checks) are sampled every 60 s while a visible tab watches.
// Owner only.
import { connectionProblems } from "../accounts/connection-problems.js";
import { followAgentSwitch } from "../assistants/live-runtime-topics.js";

export const CONNECTION_PROBLEMS_SAMPLE_MS = 60000;

/** The topic definition for LiveHub#define. */
export function connectionProblemsTopic(services) {
  return {
    name: "connections.problems",
    mode: "state",
    sampleMs: CONNECTION_PROBLEMS_SAMPLE_MS,
    authorize: (principal) => principal?.role === "owner",
    scopeKey: () => "owner",
    read: () => connectionProblems(services),
    watch: ({ invalidate }) => followAgentSwitch(services, invalidate),
  };
}
