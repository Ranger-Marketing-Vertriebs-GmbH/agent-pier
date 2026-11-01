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
  PREVIEW_RANGE_INVALID:
    "Invalid port range: ports 1024 to 65535, at most 50 ports, excluding AgentPier's port, the pipeline port range and the Tailscale HTTPS port.",
};
