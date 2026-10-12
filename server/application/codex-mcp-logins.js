import { CodexMcpLogins } from "../features/mcp-servers/codex-mcp-logins.js";
import { cliOAuthCallback } from "../features/mcp-servers/oauth-redirect.js";

/**
 * Brokered Codex MCP logins for the central MCP servers, or null without the server
 * store. Before Codex runs, the account gets the central servers exactly as a session
 * start writes them (canonical profile, then the shared projection), so the login and
 * later sessions agree on the server's name and URL. A completed login shows at once
 * and the next list reads Codex again. `config.cliLoginSpawn` replaces starting the
 * CLI; test fixtures set it so that no test reaches the real Codex unless it opts in.
 */
export function createCodexMcpLogins(services, effective) {
  if (!services.mcpServers) return null;
  const status = () => services.cliMcp?.oauthStatus;
  return new CodexMcpLogins({
    accounts: services.accounts,
    servers: services.mcpServers,
    tools: () => services.tools?.() ?? [],
    prepare: async (account) => {
      services.cliMcp?.reconcileOne("codex");
      services.sharedProfiles?.prepare(account, null);
    },
    callbackBase: () => cliOAuthCallback(effective()),
    remoteUrl: () => effective().remoteUrl,
    ...(services.config.cliLoginSpawn ? { spawn: services.config.cliLoginSpawn } : {}),
    // Never waits for a status read in flight: the callback answers at once.
    onSettled: ({ accountId, name, result }) => {
      const current = status();
      if (!current) return;
      if (result === "connected") current.mark(accountId, name, "connected");
      current.invalidate();
    },
    // A login that ended without a callback closes its `mcp.started` in the audit.
    onClosed: ({ serverId, accountId, reason }) =>
      services.audit?.append({
        action: "mcp.failed",
        resourceType: "mcp",
        resourceId: serverId,
        source: "system",
        outcome: "failure",
        details: { clis: ["codex"], accountId, failReason: reason },
      }),
  });
}
