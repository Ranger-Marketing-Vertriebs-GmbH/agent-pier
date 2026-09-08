import path from "node:path";
import { createMcpAccess } from "../features/mcp/access-service.js";
import { mcpHttpRouter } from "../features/mcp/http-transport.js";
import { McpTools } from "../features/mcp/tool-service.js";
export function createMcpServices(services, effective = () => services.config) {
  const options = {
    directory: path.join(services.config.dataDir, "mcp-access"),
    resolveResources: () => ({
      projects: services.memory.projects().projects,
      accounts: services.accounts.list().filter((account) => account.tool !== "shell"),
      connections: services.providerConnections.list(),
    }),
    onEvent: (event) => {
      try {
        services.audit.append({
          action: event.action,
          resourceType: "mcp",
          source: event.reason && event.reason !== "owner" ? "system" : "user",
          outcome: "success",
          ...(event.grantId ? { resourceId: event.grantId } : {}),
          details: {
            ...(event.resourceCount !== undefined ? { count: event.resourceCount } : {}),
            clientId: event.clientId,
            ...(event.grantId ? { grantId: event.grantId } : {}),
          },
        });
      } catch {
        services.onError();
      }
    },
  };
  // Resolve after listen so ephemeral ports and the advertised OAuth resource agree.
  let access;
  let origin;
  const current = () => {
    const config = effective();
    const publicUrl =
      config.remoteUrl || (config.port > 0 ? `http://127.0.0.1:${config.port}` : null);
    if (!access || origin !== publicUrl) {
      access?.close();
      access = createMcpAccess({ ...options, publicUrl });
      origin = publicUrl;
    }
    return access;
  };
  if (effective().port > 0 || effective().remoteUrl) current();
  const mcpAccess = {
    initialize: current,
    publicRouter: (req, res, next) => current().publicRouter(req, res, next),
    close: () => access?.close(),
  };
  for (const method of [
    "verifyAccessToken",
    "checkAccessToken",
    "status",
    "listGrants",
    "consent",
    "approve",
    "deny",
    "revoke",
  ])
    mcpAccess[method] = (...args) => current()[method](...args);
  const mcpTools = new McpTools(services);
  const mcpTransport = mcpHttpRouter({ mcpAccess, mcpTools });
  return { mcpAccess, mcpTools, mcpTransport };
}
