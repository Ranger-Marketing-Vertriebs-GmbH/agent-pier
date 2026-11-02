import { AgentPierMcpOAuth } from "../../server/features/mcp-servers/mcp-oauth-agentpier.js";
import { mcpRoute } from "../../server/features/mcp-servers/mcp-proxy.js";
import { proxiedServers } from "../../server/features/mcp-servers/mcp-inputs.js";
import { RuntimeProxy } from "../../server/features/model-logins/runtime-proxy.js";
import { approve, oauthMcpServer } from "./mcp-oauth-test-server.js";

// An OAuth MCP server (mcp-oauth-test-server.js) whose login AgentPier made and holds
// in `dataDir`, behind AgentPier's MCP proxy, as the native contracts of both runtimes
// use it. `inputs` are the store inputs a runtime compiles (mcp-inputs.js
// proxiedServers): the proxy URL and the credential of `consumer` (a Hermes agent's
// runtime id or "openclaw"), never an OAuth token; `authorize(serverId, consumer)`
// stands in for proxy-access.js.
export async function agentPierMcpLogin(
  t,
  dataDir,
  {
    name = "docs",
    id = "srv-1",
    consumer = "openclaw",
    authorize = () => true,
    transport = "http",
  } = {},
) {
  const oauth = await oauthMcpServer();
  const url0 = transport === "sse" ? oauth.sseUrl : oauth.url;
  const server = { id, name, url: url0, transport, auth: "oauth" };
  const agentpier = new AgentPierMcpOAuth({ dataDir });
  const proxy = new RuntimeProxy({ dataDir, warn: () => {} });
  proxy.route(
    "mcp",
    mcpRoute({
      servers: { definition: (s) => (s === id ? server : null) },
      oauth: agentpier,
      authorize,
    }),
  );
  const url = await proxy.start();
  t.after(async () => {
    await proxy.close();
    await oauth.close();
  });
  const started = await agentpier.start(server, {
    redirectUrl: "http://127.0.0.1:4380/api/mcp-servers/oauth/callback",
  });
  const callback = await approve(started.authorizationUrl);
  await agentpier.complete(
    agentpier.take(callback.searchParams.get("state")),
    server,
    callback.searchParams.get("code"),
  );
  const inputs = proxiedServers(
    { servers: [server], bindings: {}, secrets: { [id]: { headers: {}, env: {} } } },
    {
      url,
      credentialFor: (serverId) => proxy.credential(["mcp", serverId, consumer]),
      held: (serverId) => agentpier.held(serverId),
    },
  );
  return { oauth, server, agentpier, proxy, url, inputs };
}
