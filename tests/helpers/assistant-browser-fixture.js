// Unrelated browser fixtures run with agents switched off: the only requests the UI
// may make then are the opt-in switch and the central MCP server list with its finds
// in the CLIs (empty, shown on Accounts with or without agents); any other one fails
// in strict fixtures.
export async function fulfillDormantAssistantRequest(route) {
  const request = route.request();
  if (request.method() !== "GET") return false;
  const path = new URL(request.url()).pathname;
  if (path === "/api/mcp-servers") {
    await route.fulfill({ json: [] });
    return true;
  }
  if (path === "/api/mcp-servers/cli-finds") {
    await route.fulfill({ json: { finds: [], problems: [] } });
    return true;
  }
  if (path !== "/api/assistant-feature") return false;
  await route.fulfill({ json: { enabled: false, error: null } });
  return true;
}

// For fixtures that exercise assistants: answers the opt-in switch as enabled.
export async function fulfillEnabledAssistantFeature(route) {
  const request = route.request();
  if (new URL(request.url()).pathname !== "/api/assistant-feature") return false;
  await route.fulfill({ json: { enabled: true, error: null } });
  return true;
}
