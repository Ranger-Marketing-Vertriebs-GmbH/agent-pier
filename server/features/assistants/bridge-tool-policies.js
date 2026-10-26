/**
 * The bridge routes that answer the team plugin's tool hooks from an `assistants`
 * service of the same name: image_generate (image-policy.js) and pdf (pdf-policy.js).
 * A closed bridge or a missing service refuses; the hook then blocks the call.
 */
export const toolPolicyRoutes = {
  // Every image_generate call is checked and audited.
  "/image-policy": "imagePolicy",
  // Every pdf call reads with the model AgentPier names for its agent.
  "/pdf-policy": "pdfPolicy",
};

export function toolPolicy(bridge, url, input) {
  const policy = bridge.assistants[toolPolicyRoutes[url]];
  if (bridge.closed || !policy) return { allow: false, reason: "unavailable" };
  return policy.check(input);
}
