import { operationsFixture } from "./operations-fixture.js";
export async function mcpFixture(page) {
  await operationsFixture(page);
  const scopes = [
    "catalog:read",
    "definitions:write",
    "runs:read",
    "runs:start",
    "runs:cancel",
    "runs:publish",
  ];
  const state = {
    calls: [],
    fail: "",
    available: true,
    mcpUrl: "https://agentpier.example.test/mcp",
    grants: Array.from({ length: 21 }, (_, index) => ({
      id: `grant-${index}`,
      client: {
        id: `client-${index}`,
        name: index ? `Client ${index}` : "Codex <untrusted>",
      },
      scopes: ["catalog:read", "runs:read"],
      projectIds: ["project-one"],
      accountIds: ["account-one"],
      connectionIds: [],
      createdAt: Date.UTC(2026, 8, 7),
      expiresAt: Date.UTC(2099, 0, 1),
      revokedAt: null,
      lastUsedAt: null,
    })),
  };
  await page.route("**/api/mcp-access**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const body = request.postData() ? request.postDataJSON() : null;
    state.calls.push({ path, method: request.method(), body });
    if (state.fail === path)
      return route.fulfill({
        status: 410,
        json: { error: "Diese Anfrage ist abgelaufen." },
      });
    let result;
    if (path === "/api/mcp-access")
      result = {
        available: state.available,
        mcpUrl: state.available ? state.mcpUrl : null,
        scopes,
        resources: {
          projects: [{ id: "project-one", name: "Testprojekt" }],
          accounts: [{ id: "account-one", name: "Testkonto" }],
          connections: [{ id: "connection-one", name: "Testanbieter" }],
        },
      };
    else if (path === "/api/mcp-access/grants") {
      const offset = Number(url.searchParams.get("offset") || 0),
        limit = Number(url.searchParams.get("limit") || 20);
      result = {
        grants: state.grants.slice(offset, offset + limit),
        total: state.grants.length,
        offset,
        limit,
      };
    } else if (path.endsWith("/revoke")) {
      state.grants.find((grant) => path.includes(grant.id + "/")).revokedAt = Date.now();
      result = { revoked: true };
    } else if (path.endsWith("/approve") || path.endsWith("/deny"))
      result = { redirectUrl: "http://127.0.0.1:19876/callback?code=fixture" };
    else
      result = {
        id: "auth-one",
        client: {
          id: "cli-one",
          name: "Codex <untrusted>",
          redirectUris: ["http://127.0.0.1:19876/callback"],
        },
        requestedScopes: scopes,
        expiresAt: Date.UTC(2099, 0, 1),
      };
    return route.fulfill({ json: result });
  });
  await page.route("http://127.0.0.1:19876/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<p>CLI callback received</p>" }),
  );
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value) => {
          window.copiedText = value;
        },
      },
    }),
  );
  return state;
}
