// Unrelated browser fixtures run with agents switched off: the only assistant request
// the UI may make is the opt-in switch, and any other one fails in strict fixtures.
export async function fulfillDormantAssistantRequest(route) {
  const request = route.request();
  if (request.method() !== "GET") return false;
  if (new URL(request.url()).pathname !== "/api/assistant-feature") return false;
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
