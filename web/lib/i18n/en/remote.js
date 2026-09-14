export const remoteCopy = {
  title: "Remote access",
  description: "How AgentPier is reachable from other devices.",
  local: "Local",
  localDescription: "Always active. Reachable only on this machine.",
  tailscale: "Tailscale",
  tailscaleDescription:
    "Private HTTPS inside your tailnet, bound to the approved Tailscale account.",
  tailscaleOff: "Not configured. On the server: npm run tailscale",
  network: "Network",
  networkSwitch: "Network access",
  networkDescription:
    "Reachable without TLS at this machine's address. Only the login protects the workspace.",
  warningTitle: "Enable plain HTTP?",
  warning:
    "WARNING: Network access without TLS. Password and content travel unencrypted through the network. No push notifications and no PWA installation. Use only in trusted networks and never forward the port to the internet.",
  warningConfirm: "Enable anyway",
  warningCancel: "Cancel",
  activeWarning: "Network access without TLS is active. Trusted networks only.",
  bind: "Bind address",
  bindAll: "All interfaces (0.0.0.0)",
  bindAllV6: "All interfaces incl. IPv6 (::)",
  hosts: "Additional hosts",
  hostsDescription:
    "Names or IPs without port, such as your own DNS name or the host of a reverse proxy. Detected addresses are allowed automatically.",
  hostInput: "Additional host",
  addHost: "Add host",
  removeHost: (host) => `Remove ${host}`,
  urls: "Reachable addresses",
  locked:
    "Through network access the mode can only be switched off. Change bind address and host list locally or through Tailscale.",
  save: "Save",
  saved: "Saved.",
  restartRequired: "Restart required for the change to apply.",
  restart: "Restart service",
  restarting: "Service is restarting …",
  restarted: "Service restarted.",
  restartFailed:
    "The service did not come back. Restart manually: npm run service:install or npm start.",
  scriptHint: "Headless: npm run remote -- enable --accept-plain-http",
  loading: "Loading remote access …",
};
