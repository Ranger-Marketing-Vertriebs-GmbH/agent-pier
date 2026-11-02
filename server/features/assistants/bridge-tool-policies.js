import { hermesGuard } from "./hermes-tool-guard.js";
import { hermesRoutineApproval } from "./hermes-routine-approvals.js";

/**
 * The bridge routes that answer the team plugin's tool hooks from an `assistants`
 * service of the same name: image_generate (image-policy.js) and pdf (pdf-policy.js),
 * the Hermes team plugin's guard (hermes-tool-guard.js) and the Hermes guard
 * plugin's question in a routine run (hermes-routine-approvals.js). A closed bridge or a
 * missing service refuses; the hook then blocks the call.
 */
export const toolPolicyRoutes = {
  // A Hermes agent's file changes (team members) and browser calls.
  "/hermes-guard": "hermesGuard",
  // A Hermes routine run's command the owner is asked about; waits for the answer.
  "/hermes-approval": "hermesRoutineApproval",
  // Every image_generate call is checked and audited.
  "/image-policy": "imagePolicy",
  // Every pdf call reads with the model AgentPier names for its agent.
  "/pdf-policy": "pdfPolicy",
};

export function toolPolicy(bridge, url, input) {
  if (url === "/hermes-guard")
    return bridge.closed ? { allow: false } : hermesGuard(bridge, input);
  if (url === "/hermes-approval")
    return bridge.closed ? { allow: false } : hermesRoutineApproval(bridge, input);
  const policy = bridge.assistants[toolPolicyRoutes[url]];
  if (bridge.closed || !policy) return { allow: false, reason: "unavailable" };
  return policy.check(input);
}
