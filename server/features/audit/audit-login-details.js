import net from "node:net";

// Sign-ins at the workspace (server/http/login.js): how the request arrived, why it was
// refused and, over the plain network, from which address. Never a username, a
// password, a session token, the setup code or a Tailscale login.
const branches = ["local", "tailscale", "network"];
const reasons = ["credentials", "throttled", "setup-code"];

export function loginAuditDetails(details, event) {
  if (branches.includes(details.branch)) event.details.branch = details.branch;
  if (reasons.includes(details.reason)) event.details.reason = details.reason;
  if (typeof details.address === "string" && net.isIP(details.address))
    event.details.address = details.address;
}
