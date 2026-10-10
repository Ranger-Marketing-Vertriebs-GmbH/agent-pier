import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./providers-fixture.js";

const assistant = (id, extra = {}) => ({
  id,
  name: id,
  instructions: "",
  model: { connectionId: "router", modelId: "openai/gpt-4.1-mini" },
  revision: 1,
  effectiveRevision: 1,
  ...extra,
});

async function featureFixture(
  page,
  {
    enabled = false,
    error = null,
    assistants = [],
    failChecks = 0,
    delay = 0,
    failPut = false,
  } = {},
) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.__streams = [];
    window.EventSource = class extends Native {
      constructor(url) {
        super(url);
        window.__streams.push(this);
      }
    };
  });
  const feature = { enabled, error };
  const requests = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/assistant/.test(path)) requests.push(`${request.method()} ${path}`);
  });
  await page.route(/\/api\/assistant/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/assistant-feature") {
      if (request.method() === "GET" && failChecks > 0) {
        failChecks -= 1;
        return route.fulfill({ status: 500, json: {} });
      }
      if (request.method() === "GET" && delay)
        await new Promise((r) => setTimeout(r, delay));
      if (request.method() === "PUT" && failPut)
        return route.fulfill({ status: 409, json: { code: "ASSISTANT_RUNTIME_BUSY" } });
      if (request.method() === "PUT") feature.enabled = request.postDataJSON().enabled;
      return route.fulfill({ json: { ...feature } });
    }
    if (!feature.enabled)
      return route.fulfill({ status: 404, json: { code: "ASSISTANTS_DISABLED" } });
    if (path === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    if (path === "/api/assistants")
      return route.fulfill({
        json: {
          assistants,
          conversations: [],
          models: [],
          policies: {},
          teamSettings: { revision: 0, hostMaxConcurrent: 8 },
        },
      });
    if (path === "/api/assistant-runtime")
      return route.fulfill({
        json: { availability: "ready", sync: "current", version: "2026.9.8" },
      });
    return route.fallback();
  });
  return { requests, feature };
}

const agentsNav = (page) =>
  page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Agents", exact: true });
const hasAssistantCss = (page) =>
  page.evaluate(() =>
    [...document.styleSheets].some((sheet) => {
      try {
        return [...sheet.cssRules].some((rule) =>
          rule.cssText.includes(".assistant-message"),
        );
      } catch {
        return false;
      }
    }),
  );
test("disabled agents make one request and render no assistant UI", async ({ page }) => {
  const { requests } = await featureFixture(page);
  await page.goto(baseURL + "/");
  await expect(page.getByRole("navigation", { name: /main|navigation/i })).toBeVisible();
  await page.waitForTimeout(500);
  expect(requests).toEqual(["GET /api/assistant-feature"]);
  await expect(agentsNav(page)).toHaveCount(0);
  await expect(page.getByText("Agent chats")).toHaveCount(0);
  expect(await hasAssistantCss(page)).toBe(false);
  await page.goto(baseURL + "/settings/assistants");
  await expect(page.getByRole("switch", { name: "Enable agents" })).toBeVisible();
  expect(await hasAssistantCss(page)).toBe(false);
  await page.goto(baseURL + "/accounts");
  await expect(page.getByRole("heading", { name: "Accounts" }).first()).toBeVisible();
  await expect(page.getByText(/speech recognition/i)).toHaveCount(0);
  await expect(page.getByText("Agent model connections")).toHaveCount(0);
  expect(await hasAssistantCss(page)).toBe(false);
  expect(requests.every((r) => r === "GET /api/assistant-feature")).toBe(true);
});

test("settings switch enables agents and shows navigation after artifacts", async ({
  page,
}) => {
  const { feature } = await featureFixture(page, { assistants: [assistant("home")] });
  await page.goto(baseURL + "/settings/assistants");
  const toggle = page.getByRole("switch", { name: "Enable agents" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  expect(feature.enabled).toBe(true);
  const labels = await page
    .locator("nav[aria-label] > .nav-item")
    .evaluateAll((items) => items.map((item) => item.textContent.trim()));
  expect(labels.indexOf("Agents")).toBeGreaterThan(labels.indexOf("Artifacts"));
  await expect(page.getByRole("button", { name: "Agent chats" })).toBeVisible();
});

test("agent group stays hidden without agents", async ({ page }) => {
  await featureFixture(page, { enabled: true });
  await page.goto(baseURL + "/");
  await expect(agentsNav(page)).toBeVisible();
  await expect(page.getByText("Agent chats")).toHaveCount(0);
});

test("team members are collapsed under their parent", async ({ page }) => {
  await featureFixture(page, {
    enabled: true,
    assistants: [
      assistant("lead"),
      assistant("scout", {
        teamMemberId: "m1",
        parentAssistantId: "lead",
        lifetime: "task",
        teamId: "t1",
      }),
    ],
  });
  await page.goto(baseURL + "/");
  await expect(page.getByRole("button", { name: /^lead, / })).toBeVisible();
  await expect(page.getByRole("button", { name: /^scout, / })).toHaveCount(0);
  await page.getByRole("button", { name: /Show team members/ }).click();
  await expect(page.getByRole("button", { name: /^scout, / })).toBeVisible();
});

test("enabled agents with a storage error show a translated diagnostic", async ({
  page,
}) => {
  await featureFixture(page, { enabled: true, error: "ASSISTANT_STORAGE_UNSAFE" });
  await page.goto(baseURL + "/settings/assistants");
  await expect(page.getByRole("alert")).toContainText(/owned by AgentPier/);
  await expect(page.getByRole("alert")).not.toContainText("ASSISTANT_STORAGE_UNSAFE");
});

test("a failed first check shows a diagnostic and recovers without a reload", async ({
  page,
}) => {
  await featureFixture(page, {
    enabled: true,
    failChecks: 2,
    assistants: [assistant("home")],
  });
  await page.goto(baseURL + "/settings/assistants");
  await expect(page.getByRole("alert")).toContainText("Could not check");
  await expect(page.getByRole("switch", { name: "Enable agents" })).toBeChecked({
    timeout: 12000,
  });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(agentsNav(page)).toBeVisible();
});

test("the workspace renders without waiting for a slow feature check", async ({
  page,
}) => {
  await featureFixture(page, { enabled: true, delay: 3000 });
  await page.goto(baseURL + "/");
  await expect(page.getByRole("button", { name: "Overview" })).toBeVisible({
    timeout: 1500,
  });
  await expect(agentsNav(page)).toHaveCount(0);
  await expect(agentsNav(page)).toBeVisible({
    timeout: 6000,
  });
});

test("toggling agents keeps local application state", async ({ page }) => {
  await featureFixture(page);
  await page.goto(baseURL + "/settings/assistants");
  await page.getByRole("button", { name: "Collapse navigation" }).click();
  await expect(page.locator(".app.sidebar-collapsed")).toHaveCount(1);
  await page.getByRole("switch", { name: "Enable agents" }).click();
  await expect(page.getByRole("switch", { name: "Enable agents" })).toBeChecked();
  await expect(page.locator(".app.sidebar-collapsed")).toHaveCount(1);
  await page.getByRole("button", { name: "Expand navigation" }).first().click();
  await expect(agentsNav(page)).toBeVisible();
});

test("switching agents off removes navigation and closes the event stream", async ({
  page,
}) => {
  await featureFixture(page, { enabled: true, assistants: [assistant("home")] });
  await page.goto(baseURL + "/settings/assistants");
  await expect(page.getByRole("button", { name: "Agent chats" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__streams.length)).toBe(1);
  await page.getByRole("switch", { name: "Enable agents" }).click();
  await expect(agentsNav(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Agent chats" })).toHaveCount(0);
  expect(
    await page.evaluate(() => window.__streams.map((stream) => stream.readyState)),
  ).toEqual([2]);
});

test("a rejected switch change reports the problem and stays off", async ({ page }) => {
  await featureFixture(page, { failPut: true });
  await page.goto(baseURL + "/settings/assistants");
  const toggle = page.getByRole("switch", { name: "Enable agents" });
  await toggle.click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await expect(agentsNav(page)).toHaveCount(0);
});
