import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./providers-fixture.js";

/** The central MCP API; `state` records requests and holds what the list returns. */
async function setup(
  page,
  { language = "en", agents = false, servers = [], finds = [] } = {},
) {
  await fixture(page);
  await page.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  const state = {
    requests: [],
    servers: structuredClone(servers),
    finds: structuredClone(finds),
  };
  await page.route("**/api/assistant-feature", (route) =>
    route.fulfill({ json: { enabled: agents, error: null } }),
  );
  await page.route(/\/api\/mcp-servers/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postData() ? request.postDataJSON() : undefined;
    state.requests.push({ method: request.method(), path, body });
    if (path === "/api/mcp-servers" && request.method() === "GET")
      return route.fulfill({ json: state.servers });
    if (path === "/api/mcp-servers/cli-finds")
      return route.fulfill({ json: { finds: state.finds } });
    if (state.handle) {
      const handled = await state.handle({ route, request, path, body });
      if (handled !== false) return;
    }
    return route.fulfill({ status: 404, json: { error: "unexpected" } });
  });
  return state;
}

const header = (extra = {}) => ({
  id: "s1",
  name: "docs",
  transport: "http",
  url: "https://mcp.example.test/mcp",
  auth: "headers",
  headerNames: ["Authorization"],
  envNames: [],
  revision: 1,
  ...extra,
});

test("the central MCP list is on Accounts without agents and offers no agent login", async ({
  page,
}) => {
  await setup(page, { servers: [header({ auth: "oauth", headerNames: [] })] });
  await page.goto(baseURL + "/accounts");
  await expect(
    page.getByRole("heading", { name: "MCP servers", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("docs", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /log in/i })).toHaveCount(0);
});
