import { runtimeToolRoutes } from "./runtimes/runtime-services.js";

// The policies of an `assistants` service of the same name.
const policyRoutes = {
  // Every image_generate call is checked and audited.
  "/image-policy": "imagePolicy",
  // Every pdf call reads with the model AgentPier names for its agent.
  "/pdf-policy": "pdfPolicy",
};

/**
 * The bridge routes that answer tool hooks: image_generate (image-policy.js) and pdf
 * (pdf-policy.js) from an `assistants` service of the same name, and the routes a
 * runtime's own plugins call, which that runtime answers (runtimes/runtime-services.js
 * runtimeToolRoutes; Hermes's guard, routine approval and browser upload). A closed
 * bridge or a missing service refuses; the hook then blocks the call.
 */
export const toolPolicyRoutes = () => [
  ...Object.keys(runtimeToolRoutes()),
  ...Object.keys(policyRoutes),
];

export function toolPolicy(bridge, url, input) {
  const routes = runtimeToolRoutes();
  if (Object.hasOwn(routes, url))
    return bridge.closed ? { ...routes[url].closed } : routes[url].answer(bridge, input);
  const policy = bridge.assistants[policyRoutes[url]];
  if (bridge.closed || !policy) return { allow: false, reason: "unavailable" };
  return policy.check(input);
}
