import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./providers-fixture.js";

test.use({ locale: "en-GB" });

const chatOnly = {
  id: "gpu",
  name: "GPU box",
  providerId: "endpoint",
  hasSecret: false,
  launchable: true,
  tools: ["codex", "claude", "opencode"],
  toolRoutes: {
    claude: { mode: "adapter", source: "chatCompletions" },
    codex: { mode: "adapter", source: "chatCompletions" },
    opencode: { mode: "native", source: "chatCompletions" },
  },
  endpoint: {
    openaiBaseUrl: "http://gpu.example:8080/v1",
    anthropicBaseUrl: "",
    authHeader: "",
    protocols: { messages: false, responses: false, chatCompletions: true },
    routing: { claude: "auto", codex: "auto", opencode: "auto" },
    adapterCapabilities: {},
    thinkTagExtraction: false,
    models: [],
  },
};

test("connection list and launch dialog label adapter routes", async ({ page }) => {
  const controls = await fixture(page);
  controls.state.providerConnections = [chatOnly];
  await page.goto(baseURL + "/accounts");
  await expect(
    page.getByText(
      "Compatible CLIs: Codex (via adapter · Chat Completions), Claude Code (via adapter · Chat Completions), OpenCode (native)",
    ),
  ).toBeVisible();
  await page.goto(baseURL + "/");
  await page.getByRole("button", { name: "New session", exact: true }).first().click();
  await page.getByLabel("CLI", { exact: true }).selectOption("claude");
  await expect(
    page
      .getByLabel("Connection", { exact: true })
      .locator('option[value="provider:gpu"]'),
  ).toContainText("via adapter · Chat Completions");
});

const adapterSession = {
  id: "adapter-session",
  name: "Adapter session",
  tool: "claude",
  accountId: "internal-isolated-profile",
  cwd: "/fixture",
  status: "running",
  access: {
    providerConnectionId: "gpu",
    providerConnectionName: "GPU box",
    providerId: "endpoint",
    providerModelId: "qwen3",
  },
  provider: {
    requestedModelId: "qwen3",
    modelChangeRequiresRestart: true,
    route: { mode: "adapter", source: "chatCompletions" },
  },
};

test("the session header shows the route of endpoint sessions only", async ({ page }) => {
  await fixture(page, { session: adapterSession });
  await page.goto(baseURL + "/sessions/adapter-session/chat");
  await expect(page.locator(".session-title .route-badge")).toHaveText(
    "via adapter · Chat Completions",
  );
});

test("the route badge fits the session header on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, { session: adapterSession });
  // The phone chat view hides the whole subtitle; the terminal view keeps it.
  await page.goto(baseURL + "/sessions/adapter-session/terminal");
  await expect(page.locator(".session-title .route-badge")).toBeVisible();
  const layout = await page.evaluate(() => {
    const right = (selector) =>
      Math.max(
        ...[...document.querySelectorAll(selector)].map(
          (element) => element.getBoundingClientRect().right,
        ),
      );
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      badge: right(".session-title .route-badge"),
      actions: right(".session-actions"),
      width: window.innerWidth,
    };
  });
  expect(layout.page).toBeLessThanOrEqual(0);
  expect(layout.badge).toBeLessThanOrEqual(layout.width);
  expect(layout.actions).toBeLessThanOrEqual(layout.width);
});

test("native account sessions have no route badge", async ({ page }) => {
  await fixture(page, {
    session: {
      id: "native-session",
      name: "Native session",
      tool: "codex",
      accountId: "local-codex",
      cwd: "/fixture",
      status: "running",
    },
  });
  await page.goto(baseURL + "/sessions/native-session/chat");
  await expect(page.locator(".session-title h1")).toHaveText("Native session");
  await expect(page.locator(".session-title .route-badge")).toHaveCount(0);
});

test("the reload dialog warns when the route changed since the start", async ({
  page,
}) => {
  await fixture(page, { session: adapterSession });
  // Registered after the fixture, so it takes precedence over its catch-all route
  // (which throws on unknown requests).
  await page.route("**/api/sessions/adapter-session/reload", (route) =>
    route.fulfill({
      json: {
        eligible: true,
        reason: null,
        nativeId: "native-fixture",
        accountTargets: [],
        activity: { state: "idle" },
        state: "idle",
        error: null,
        requestId: null,
        routeChange: {
          from: { mode: "native", source: "messages" },
          to: { mode: "adapter", source: "chatCompletions" },
        },
      },
    }),
  );
  await page.goto(baseURL + "/sessions/adapter-session/chat");
  await page.getByRole("button", { name: "Reload & resume", exact: true }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByText(
        "The route changed since this session started (before: native, now: via adapter · Chat Completions). Reasoning data from the earlier conversation cannot be carried over.",
        { exact: true },
      ),
  ).toBeVisible();
});
