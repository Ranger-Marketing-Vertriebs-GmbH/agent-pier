import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import {
  accountDetail,
  accountRow,
  keyInput,
  openAccountItem,
  saveBar,
} from "../helpers/accounts-browser.js";
import { fixture } from "./providers-fixture.js";

test.use({ locale: "en-GB" });

const router = {
  id: "c1",
  name: "Agent router",
  providerId: "openrouter",
  hasSecret: true,
  launchable: true,
  tools: ["codex"],
};
const other = { ...router, id: "c2", name: "Second router" };
const phone = { width: 390, height: 844 };

async function setup(page) {
  const controls = await fixture(page);
  controls.state.providerConnections = [router, other];
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  return controls;
}

const writes = (controls, method) =>
  controls.calls.filter(
    (call) => call.method === method && call.path.startsWith("/api/"),
  );

/** The MCP server API with one server whose revision `state.revision` decides. */
async function mcpApi(page, state) {
  await page.route(/\/api\/mcp-servers/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/mcp-servers/cli-finds")
      return route.fulfill({ json: { finds: [], problems: [] } });
    if (request.method() === "GET") {
      state.reads += 1;
      if (state.hold) await state.hold;
      if (state.failList)
        return route.fulfill({ status: 500, json: { error: "MCP list unavailable" } });
      return route.fulfill({
        json: [
          {
            id: "s1",
            name: "docs",
            transport: "http",
            url: "https://docs.example/mcp",
            headerNames: [],
            envNames: [],
            auth: "headers",
            revision: state.revision,
          },
        ],
      });
    }
    const body = request.postDataJSON();
    state.puts.push(body);
    if (body.revision !== state.revision)
      return route.fulfill({
        status: 409,
        json: { error: "Changed elsewhere", messageKey: "mcpServers.conflict" },
      });
    state.revision += 1;
    return route.fulfill({ json: { id: "s1", name: "docs", revision: state.revision } });
  });
}

test("Cancel returns a replaced key to its status line", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/accounts");
  const detail = await openAccountItem(page, "Agent router");
  await (await keyInput(detail, "API key")).fill("new-key");
  await saveBar(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    detail.getByRole("button", { name: "Replace", exact: true }),
  ).toBeVisible();
  await expect(detail.getByLabel("API key", { exact: true })).toHaveCount(0);
});

test("Save and switch does not send a form that is not valid", async ({ page }) => {
  const controls = await setup(page);
  await page.goto(baseURL + "/accounts");
  const detail = await openAccountItem(page, "Agent router");
  await detail.getByLabel("Connection name", { exact: true }).fill("");
  await accountRow(page, "Second router").click();
  await page.getByRole("button", { name: "Save and switch" }).click();
  await expect(page).toHaveURL(/item=c1/);
  expect(writes(controls, "PATCH")).toHaveLength(0);
  // Enter in the form is held back the same way.
  await detail.getByLabel("Connection name", { exact: true }).press("Enter");
  expect(writes(controls, "PATCH")).toHaveLength(0);
});

test("deleting a changed connection leaves without asking", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/accounts");
  const detail = await openAccountItem(page, "Agent router");
  await detail.getByLabel("Connection name", { exact: true }).fill("Changed");
  await detail.getByRole("button", { name: "Delete connection", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete connection", exact: true })
    .click();
  await expect(page).toHaveURL(`${baseURL}/accounts?section=models`);
  await expect(page.getByRole("dialog", { name: "Save changes?" })).toHaveCount(0);
  await expect(accountRow(page, "Agent router")).toHaveCount(0);
});

test("the open entry is the current row", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/accounts?section=models&item=c1");
  await expect(accountRow(page, "Agent router")).toHaveAttribute("aria-current", "page");
  await expect(accountRow(page, "Second router")).not.toHaveAttribute(
    "aria-current",
    /.*/,
  );
});

test("an open native account is polled once and shows its sign-in at once", async ({
  page,
}) => {
  const controls = await setup(page);
  controls.state.accounts = [
    { id: "managed-codex", name: "Work Codex", tool: "codex", kind: "managed" },
  ];
  let polls = 0;
  await page.route("**/api/accounts/*/auth-status", (route) => {
    polls += 1;
    return route.fulfill({ json: { state: "authenticated" } });
  });
  await page.goto(baseURL + "/accounts?section=cli&item=managed-codex");
  await expect(accountDetail(page).getByText("Signed in", { exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  expect(polls).toBe(1);
});

test("a native account refused by the server reports in the bar", async ({ page }) => {
  const controls = await setup(page);
  controls.state.accounts = [
    { id: "managed-codex", name: "Work Codex", tool: "codex", kind: "managed" },
  ];
  controls.state.sessions = [
    { id: "s1", accountId: "managed-codex", status: "running", tool: "codex" },
  ];
  await page.goto(baseURL + "/accounts?section=cli&item=managed-codex");
  await accountDetail(page)
    .getByLabel("API key (optional)", { exact: true })
    .fill("fixture-native-key");
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(saveBar(page).getByRole("alert")).toContainText(
    "Stop before changing provider credentials.",
  );
});

test("the ChatGPT list reloads when the agent runtime becomes ready", async ({
  page,
}) => {
  await setup(page);
  let availability = "disabled";
  let loads = 0;
  await page.route("**/api/assistant-feature", (route) =>
    fulfillEnabledAssistantFeature(route),
  );
  await page.route("**/api/assistant-runtime", (route) =>
    route.fulfill({ json: { availability, sync: "stale" } }),
  );
  // The stream ends at once and reconnects quickly; every reconnect reads the runtime.
  await page.route("**/api/assistant-events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: 'retry: 200\ndata: {"type":"connected"}\n\n',
    }),
  );
  await page.route("**/api/assistant-model-accounts", (route) => {
    loads += 1;
    return route.fulfill({
      json: {
        accounts: [
          {
            id: "openclaw:gpt1",
            name: "Team ChatGPT",
            status: availability === "ready" ? "ok" : "unknown",
          },
        ],
      },
    });
  });
  await page.goto(baseURL + "/accounts");
  await expect(accountRow(page, "Team ChatGPT")).toContainText("Service offline");
  const before = loads;
  availability = "ready";
  await expect(accountRow(page, "Team ChatGPT")).toContainText("Connected");
  expect(loads).toBeGreaterThan(before);
});

test("Overwrite anyway sends the newer MCP revision", async ({ page }) => {
  await setup(page);
  const state = { revision: 1, puts: [], reads: 0 };
  await mcpApi(page, state);
  await page.goto(baseURL + "/accounts");
  const detail = await openAccountItem(page, "docs");
  await detail.getByRole("button", { name: "Change: Source and name" }).click();
  await expect(page).toHaveURL(/item=s1&step=setup/);
  await detail.getByLabel("Address").fill("https://docs.example/v2");
  state.revision = 4;
  await saveBar(page).getByRole("button", { name: "Save changes" }).click();
  await expect(saveBar(page).getByRole("alert")).toContainText("Changed elsewhere");
  await saveBar(page).getByRole("button", { name: "Overwrite anyway" }).click();
  await expect(saveBar(page)).toHaveCount(0);
  expect(state.puts.map((body) => body.revision)).toEqual([1, 4]);
});

test("phones name a loading entry and show a failed list with a retry", async ({
  page,
}) => {
  await page.setViewportSize(phone);
  await setup(page);
  let release;
  const state = {
    revision: 1,
    puts: [],
    reads: 0,
    failList: true,
    hold: new Promise((resolve) => {
      release = resolve;
    }),
  };
  await mcpApi(page, state);
  await page.goto(baseURL + "/accounts?section=mcp-servers&item=s1");
  await expect(
    page.getByRole("heading", { level: 1, name: "MCP servers" }),
  ).toBeVisible();
  await expect(page.getByText("Loading", { exact: false }).first()).toBeVisible();
  release();
  await expect(page.getByRole("alert")).toContainText("MCP list unavailable");
  state.failList = false;
  state.hold = null;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "docs" })).toBeVisible();
});
