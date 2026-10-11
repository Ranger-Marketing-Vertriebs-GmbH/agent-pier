// `caps` declares optional client capabilities; OpenClaw routes exec approvals only
// to clients declaring "exec-approvals" (or "approvals").
export function gatewayHandshake(token, caps = []) {
  return {
    minProtocol: 4,
    maxProtocol: 4,
    client: {
      id: "gateway-client",
      version: "agentpier-1",
      platform: process.platform,
      mode: "backend",
    },
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write"],
    caps,
    auth: { token },
  };
}
export function gatewayError(code = "UNAVAILABLE") {
  return Object.assign(Error(`Assistant Gateway unavailable (${code}).`), {
    code,
    status: 503,
  });
}
