/**
 * The bridge routes that answer the team plugin's tool hooks from an `assistants`
 * service of the same name: image_generate (image-policy.js), pdf (pdf-policy.js) and
 * file reads of the agent's secrets folder (AgentHooks.secretsRead).
 * A closed bridge or a missing service refuses; the hook then blocks the call.
 */
export const toolPolicyRoutes = {
  // Every image_generate call is checked and audited.
  "/image-policy": "imagePolicy",
  // Every pdf call reads with the model AgentPier names for its agent.
  "/pdf-policy": "pdfPolicy",
  // A read of .agentpier/ (team-plugin/secrets-guard.js): refused in a hook run
  // without Secrets, allowed in every other session.
  "/secrets-policy": "hookSecrets",
};

export function toolPolicy(bridge, url, input) {
  const policy = bridge.assistants[toolPolicyRoutes[url]];
  if (bridge.closed || !policy) return { allow: false, reason: "unavailable" };
  return policy.check(input);
}
