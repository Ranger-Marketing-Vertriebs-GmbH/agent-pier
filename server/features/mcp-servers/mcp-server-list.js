/**
 * The MCP server list as GET /api/mcp-servers shows it: OAuth servers with their agent
 * login status (McpOAuthLogins.decorate), servers with agent placeholders with what
 * each bound agent's folders resolve to, and every server with its CLI bindings, their
 * status and its users (CliMcpBindings.decorate). Connection problems read the same
 * view, so a hint never disagrees with the list.
 */
export async function decoratedMcpServers(services, list) {
  if (services.assistantMcpOAuth) list = await services.assistantMcpOAuth.decorate(list);
  if (services.assistantMcpChanges)
    list = services.assistantMcpChanges.sharedViews(
      services.assistantMcpChanges.placeholderViews(list),
    );
  return services.cliMcp ? services.cliMcp.decorate(list) : list;
}
