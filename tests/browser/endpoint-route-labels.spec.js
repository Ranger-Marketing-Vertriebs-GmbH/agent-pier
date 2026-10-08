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

test("OpenCode SDK routes show only the protocol", async ({ page }) => {
  const controls = await fixture(page);
  controls.state.providerConnections = [
    {
      ...chatOnly,
      tools: ["claude", "opencode"],
      toolRoutes: {
        claude: { mode: "native", source: "messages" },
        codex: null,
        opencode: { mode: "sdk", source: "responses" },
      },
    },
  ];
  await page.goto(baseURL + "/accounts");
  await expect(
    page.getByText("Compatible CLIs: Claude Code (native), OpenCode (Responses)", {
      exact: true,
    }),
  ).toBeVisible();
  await page.goto(baseURL + "/");
  await page.getByRole("button", { name: "New session", exact: true }).first().click();
  await page.getByLabel("CLI", { exact: true }).selectOption("opencode");
  const option = page
    .getByLabel("Connection", { exact: true })
    .locator('option[value="provider:gpu"]');
  await expect(option).toContainText("· Responses");
  await expect(option).not.toContainText("via adapter");
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
  // A text separator, not only CSS margin, so screen readers keep the words apart.
  const subtitle = await page
    .locator(".session-title p")
    .evaluate((element) => element.textContent);
  expect(subtitle).toBe("Claude Code / GPU box via adapter · Chat Completions");
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
    const box = (selector) => document.querySelector(selector).getBoundingClientRect();
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      badge: right(".session-title .route-badge"),
      actions: right(".session-actions"),
      width: window.innerWidth,
      badgeBottom: box(".session-title .route-badge").bottom,
      headingBottom: box(".session-heading").bottom,
      terminalTop: box(".terminal-shell").top,
    };
  });
  expect(layout.page).toBeLessThanOrEqual(0);
  expect(layout.badge).toBeLessThanOrEqual(layout.width);
  expect(layout.actions).toBeLessThanOrEqual(layout.width);
  // The badge stays inside the header and does not overlap the terminal.
  expect(layout.badgeBottom).toBeLessThanOrEqual(layout.headingBottom);
  expect(layout.headingBottom).toBeLessThanOrEqual(layout.terminalTop);
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

async function openReload(page, routeChange) {
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
        routeChange,
      },
    }),
  );
  await page.goto(baseURL + "/sessions/adapter-session/chat");
  await page.getByRole("button", { name: "Reload & resume", exact: true }).click();
  return page.getByRole("dialog");
}

test("the reload dialog warns when the route changed since the start", async ({
  page,
}) => {
  const dialog = await openReload(page, {
    from: { mode: "native", source: "messages" },
    to: { mode: "adapter", source: "chatCompletions" },
  });
  const warning = dialog.getByText(
    "The route changed since this session started (before: native, now: via adapter · Chat Completions). Reasoning data from the earlier conversation cannot be carried over.",
    { exact: true },
  );
  await expect(warning).toBeVisible();
  // Filled into a live region that already existed, so it is announced.
  await expect(dialog.locator(".session-reload-route")).toHaveAttribute("role", "status");
  await expect(dialog.locator(".session-reload-route > p")).toHaveCount(1);
});

test("the reload dialog says when the route is no longer offered", async ({ page }) => {
  const dialog = await openReload(page, {
    from: { mode: "adapter", source: "chatCompletions" },
    to: null,
  });
  await expect(
    dialog.getByText(
      "The connection no longer offers a route for this CLI (before: via adapter · Chat Completions). The reload may fail; check the connection's routing first.",
      { exact: true },
    ),
  ).toBeVisible();
});

test("an unchanged route shows no reload warning", async ({ page }) => {
  const dialog = await openReload(page, null);
  await expect(
    dialog.getByRole("button", { name: "Reload now", exact: true }),
  ).toBeVisible();
  await expect(dialog.locator(".session-reload-route")).toBeEmpty();
});
