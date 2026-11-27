// `caps` declares optional client capabilities; OpenClaw routes exec approvals only
// to clients declaring "exec-approvals" (or "approvals"). The questions of ask_user
// (openclaw-questions.js) need no cap and the scope "operator.questions", which
// "operator.admin" includes; "no-question-input" would take the tool from every turn
// this client sends, so it is never declared.
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
