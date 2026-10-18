import { systemStatusAnswer } from "./system-status-fixture.js";
// Unrelated browser fixtures run with agents switched off: the only requests the UI
// may make then are the opt-in switch and the central MCP server list with its finds
// in the CLIs (empty, shown on Accounts with or without agents); any other one fails
// in strict fixtures.
// The start page's system status polls in every fixture that shows it; it is answered
// here too.
export async function fulfillDormantAssistantRequest(route) {
  const request = route.request();
  if (request.method() !== "GET") return false;
  const path = new URL(request.url()).pathname;
  const status = systemStatusAnswer(path);
  if (status) {
    await route.fulfill({ json: status });
    return true;
  }
  if (path === "/api/mcp-servers") {
    await route.fulfill({ json: [] });
    return true;
  }
  if (path === "/api/mcp-servers/cli-finds") {
    await route.fulfill({ json: { finds: [], problems: [] } });
    return true;
  }
  // Dormant agents bring no speech connection: the composers' microphone explains it.
  if (path === "/api/dictation") {
    await route.fulfill({
      json: { available: false, reason: "agentsOff", autoSend: false },
    });
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
