export const previews = {
  PREVIEW_NOT_LISTENING: (port) =>
    `No server is listening on port ${port}. Start the dev server and try again.`,
  PREVIEW_PORT_FORBIDDEN: (port) =>
    `Port ${port} cannot be shared as a preview (AgentPier itself, the preview port range or an internal port).`,
  PREVIEW_RANGE_FULL:
    "All preview ports are in use. Close a preview or widen the port range in Settings.",
  PREVIEW_DISABLED:
    "Previews are turned off. Turn them on under Settings › Remote access › Previews.",
  PREVIEW_UNAVAILABLE:
    "Previews are not reachable through Tailscale. Turn Settings › Remote access › Previews on again or run `npm run tailscale`.",
  PREVIEW_INVALID_INPUT: "Check the preview arguments.",
  PREVIEW_NOT_FOUND: "This preview no longer exists.",
  accessRevoked: "AgentPier access revoked or session unavailable.",
  rangeNotNumbers: "Enter whole numbers for the first and the last port.",
  rangeBounds: (low, high) => `Preview ports must lie between ${low} and ${high}.`,
  rangeOrder: "The last port must not be lower than the first port.",
  rangeSize: (count) => `The range may hold at most ${count} ports.`,
  rangeHostPort: (port) => `The range contains AgentPier's own port ${port}.`,
  rangeHostPortListener: (slot, port) =>
    `Port ${slot} cannot be used: with Tailscale its preview also listens 1000 ports higher, on ${port}, which is AgentPier's own port.`,
  rangeHttpsPort: (port) => `The range contains the Tailscale HTTPS port ${port}.`,
  rangeHttpsPortListener: (slot, port) =>
    `Port ${slot} cannot be used: with Tailscale its preview also listens 1000 ports higher, on ${port}, which is the Tailscale HTTPS port.`,
  rangePipelines: (start, end) =>
    `The range overlaps the pipeline ports ${start}–${end}.`,
  rangePipelinesListener: (start, end) =>
    `The range cannot be used: with Tailscale previews also listen 1000 ports higher, which overlaps the pipeline ports ${start}–${end}.`,
  PREVIEW_RANGE_INVALID: "Invalid preview settings.",
  pages: {
    bounceTitle: "Opening the preview …",
    bounceLink: "Continue to the preview",
    signInTitle: "Sign in to AgentPier",
    signInText:
      "This preview is served by AgentPier. Sign in to AgentPier as the owner; the preview opens again afterwards.",
    signInLink: "Sign in to AgentPier",
    forbiddenTitle: "No access",
    forbiddenText: "Only the owner of this AgentPier can open previews.",
    idleTitle: "No preview on this port",
    idleText:
      "This preview was closed or has expired. Ask the session or agent for a new link.",
    unreachableTitle: (port) => `The server on port ${port} is not answering`,
    unreachableText: (label) =>
      `The preview “${label}” stays open. Reload this page once the server is running again.`,
    unauthorized: "Sign-in to AgentPier required.",
  },
  telegram: {
    opened: (agent, label, url) => `${agent} opened the preview ${label}: ${url}`,
  },
};
