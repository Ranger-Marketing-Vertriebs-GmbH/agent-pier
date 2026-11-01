export const previewCopy = {
  title: "Previews",
  open: "Open preview",
  stop: "Stop",
  port: (port) => `Port ${port}`,
  description:
    "Coding sessions and agents can show you their running dev server. Each preview gets its own port from the range below, on the same address as AgentPier. Only you can open them.",
  enable: "Enable previews",
  enableSub: "While on, AgentPier listens on the ports below. Off by default.",
  rangeStart: "First port",
  rangeEnd: "Last port",
  rangeSub: "From 1024 to 65535, at most 50 ports.",
  locked: "Plain network access can only turn previews off.",
  portsTitle: "Ports",
  slotFree: "Free",
  slotTaken: "Used by another program",
  slotPreview: "Preview",
  activeTitle: "Active previews",
  saved: "Saved.",
  loading: "Loading previews …",
  serveTitle: "Tailscale",
  serveRegistered: (count) =>
    count === 1
      ? "1 port shared in your tailnet"
      : `${count} ports shared in your tailnet`,
  serveFailed: (ports) => `Not shared: ${ports}`,
  serveCommandsHint:
    "Run these commands on the AgentPier computer, then switch previews off and on again.",
  serveOccupied: (ports) =>
    `Another Tailscale Serve entry uses ${ports}. Choose another port range.`,
  serveNetwork:
    "Network access is on: previews open on the network addresses, not through Tailscale.",
  serveCopy: "Copy commands",
};
