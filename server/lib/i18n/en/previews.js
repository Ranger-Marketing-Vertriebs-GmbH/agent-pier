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
  PREVIEW_RANGE_INVALID:
    "Invalid port range: ports 1024 to 65535, at most 50 ports, excluding AgentPier's port, the pipeline port range and the Tailscale HTTPS port.",
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
};
