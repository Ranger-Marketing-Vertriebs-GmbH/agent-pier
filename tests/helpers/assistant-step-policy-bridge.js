import http from "node:http";

/**
 * A team bridge stand-in for native contracts that compile the team plugin without
 * running AgentPier's TeamBridge. The plugin asks /step-policy before every tool call
 * of an agent and refuses when nobody answers (team-plugin/tool-guard.js stepCall),
 * so an unreachable bridge URL would refuse every native tool. These fixtures run no
 * memory step, so the stand-in allows each step question and refuses every other
 * endpoint, exactly as an unreachable bridge does.
 */
export async function stepPolicyBridge(token) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const authorized = req.headers.authorization === `Bearer ${token}`;
      calls.push({ url: req.url, authorized, body });
      const allow = authorized && req.method === "POST" && req.url === "/step-policy";
      res.writeHead(allow ? 200 : 403, { "content-type": "application/json" });
      res.end(JSON.stringify(allow ? { allow: true } : { allow: false }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    connection: { url: `http://127.0.0.1:${server.address().port}`, token },
    calls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
