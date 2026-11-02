import { ChatGptVault } from "../features/model-logins/chatgpt-vault.js";
import { AssistantModelAccounts } from "../features/assistants/model-accounts.js";
import { AssistantAccountLogin } from "../features/assistants/model-account-login.js";
import { RuntimeProxy } from "../features/model-logins/runtime-proxy.js";
import { chatgptRoute } from "../features/model-logins/chatgpt-proxy.js";
import { proxyAccess } from "../features/assistants/proxy-access.js";
import { accountIdOf } from "../features/assistants/model-accounts.js";
import { McpOAuthLogins } from "../features/mcp-servers/mcp-oauth-logins.js";
import { McpOAuthHolders } from "../features/mcp-servers/mcp-oauth-holders.js";
import { AgentPierMcpOAuth } from "../features/mcp-servers/mcp-oauth-agentpier.js";
import { mcpRoute } from "../features/mcp-servers/mcp-proxy.js";
import { supervisorMcpCli } from "../features/mcp-servers/openclaw-mcp-cli.js";

// The logins AgentPier holds for the runtimes (ChatGPT, MCP OAuth) and the loopback
// proxy through which the runtimes use them, as the assistant graph wires them.

/**
 * AgentPier's ChatGPT vault with the model accounts and the sign-in over it, and the
 * runtime proxy (its routes follow in mcpOAuthServices). `created` records both,
 * so a failed graph construction closes them. The proxy listens at once: compiles
 * read its address synchronously.
 */
export function loginServices({ dataDir, runtime }, created) {
  // The only refresher of the owner's ChatGPT tokens.
  const chatgptVault = (created.chatgptVault = new ChatGptVault({ dataDir }));
  const runtimeProxy = (created.runtimeProxy = new RuntimeProxy({ dataDir }));
  runtimeProxy
    .start()
    .catch(() => console.warn("AgentPier's runtime proxy could not listen yet."));
  const assistantModelAccounts = new AssistantModelAccounts({
    dataDir,
    runtime,
    vault: chatgptVault,
  });
  const assistantModelLogin = new AssistantAccountLogin({
    vault: chatgptVault,
    accounts: assistantModelAccounts,
  });
  return { chatgptVault, runtimeProxy, assistantModelAccounts, assistantModelLogin };
}

/**
 * The MCP OAuth logins by holder (mcp-oauth-holders.js): OpenClaw's earlier ones over
 * its CLI, AgentPier's own behind the proxy's MCP route. `reapply()` applies the
 * store (McpChanges, built after this). Also routes the proxy's ChatGPT and MCP
 * credentials through proxy-access.js. Returns `{ oauth, proxy(consumer) }`:
 * what mcp-inputs.js compiles for a consumer once the proxy listens.
 */
export function mcpOAuthServices({
  dataDir,
  runtime,
  servers,
  assistants,
  runtimeProxy,
  redirectUrl,
  remoteUrl,
  reapply,
}) {
  const legacy = new McpOAuthLogins({
    cli: supervisorMcpCli(runtime),
    servers,
    runtime,
    admit: (operation) => assistants.admit(operation),
    redirectUrl,
    // Called under admission by a login start.
    reapply,
    onFreed: () => assistants.admit(reapply),
    remoteUrl,
  });
  const agentpier = new AgentPierMcpOAuth({ dataDir });
  const oauth = new McpOAuthHolders({
    legacy,
    agentpier,
    servers,
    admit: (operation) => assistants.admit(operation),
    redirectUrl,
    remoteUrl,
    reapply,
  });
  // Who may use a proxy credential, decided per request (proxy-access.js).
  const access = proxyAccess({ assistants, servers, accountIdOf });
  runtimeProxy.route(
    "chatgpt",
    chatgptRoute({ vault: assistants.accounts.vault, authorize: access.chatgpt }),
  );
  runtimeProxy.route(
    "mcp",
    mcpRoute({
      servers: {
        definition: (id) => servers.definitions().find((s) => s.id === id) || null,
      },
      oauth: agentpier,
      authorize: access.mcp,
    }),
  );
  // `consumer`: the Hermes agent's runtime id, or "openclaw" for the Gateway.
  const proxy = (consumer) =>
    runtimeProxy.url
      ? {
          url: runtimeProxy.url,
          credentialFor: (serverId) =>
            runtimeProxy.credential(["mcp", serverId, consumer]),
          held: (serverId) => agentpier.held(serverId),
        }
      : null;
  return { oauth, proxy };
}
