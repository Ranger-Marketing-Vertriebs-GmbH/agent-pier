import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// The installed app is reopened while AgentPier cannot be reached at all: the device
// is offline, so the document, /auth and /api all fail. The service worker opens the
// kept app shell (public/sw.js), LoginGate opens the app in offline mode for the owner
// last signed in on this device, and the app shows what the device kept: the agent
// list, the sessions and the preloaded views.
const session = {
  id: "one",
  name: "Release notes",
  accountId: "local-claude",
  tool: "claude",
  status: "running",
  cwd: "/fixture",
  createdAt: "2026-09-06T10:00:00Z",
};
const workerTest = test.extend({ serviceWorkers: "allow" });

workerTest(
  "a signed-in owner who reopens the app offline gets the app with the kept agents and sessions",
  async ({ page, context, browserName, liveStub }) => {
    test.skip(
      browserName !== "chromium",
      "Playwright service-worker automation is Chromium-only",
    );
    await chatFixture(page);
    const network = { offline: false };
    await page.route("**/api/state", async (route) => {
      if (network.offline) return route.abort("internetdisconnected");
      const response = await route.fetch();
      const state = await response.json();
      return route.fulfill({ json: { ...state, sessions: [session] } });
    });
    await page.route("**/auth/status", (route) =>
      network.offline
        ? route.abort("internetdisconnected")
        : route.fulfill({
            json: { configured: true, authenticated: true, canSetup: false },
          }),
    );
    await page.route("**/api/**", (route) =>
      network.offline ? route.abort("internetdisconnected") : route.fallback(),
    );
    await page.routeWebSocket(/\/(chat-stream|terminal)(\?.*)?$/, (socket) =>
      socket.close(),
    );
    await page.goto(baseURL + "/");
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      if (!registration.active)
        await new Promise((resolve) =>
          registration.installing.addEventListener("statechange", resolve),
        );
    });
    // Controlled from here on: the document and the code pass the worker.
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    await page.waitForFunction(
      () => document.documentElement.dataset.viewPreload === "done",
      null,
      { timeout: 20000 },
    );
    const sidebar = page.locator(".sidebar");
    await expect(sidebar.getByText("Release notes").first()).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          ["agentpier.agent-list.v1", "agentpier.workspace-state.v1"].every(
            (key) => localStorage.getItem(key) !== null,
          ),
        ),
      )
      .toBe(true);

    network.offline = true;
    liveStub.refuse();
    await context.setOffline(true);
    await page.reload();

    await expect(
      page.getByRole("heading", { name: "This device is offline" }),
    ).toHaveCount(0);
    await expect(
      page.getByText("AgentPier is unreachable. Check that it is running.").first(),
    ).toBeVisible();
    await expect(sidebar.getByText("Release notes").first()).toBeVisible();
    await expect(sidebar.getByText("Home assistant").first()).toBeVisible();
    // A preloaded view opens from the kept code.
    await page.evaluate(() => {
      window.history.pushState(null, "", "/sessions/one");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const main = page.locator("main");
    await expect(
      main.getByRole("heading", { name: "Release notes", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("View unavailable")).toHaveCount(0);
    await context.setOffline(false);
  },
);

workerTest(
  "without a kept sign-in the offline start shows the error and tries again by itself",
  async ({ page, context, browserName }) => {
    test.skip(
      browserName !== "chromium",
      "Playwright service-worker automation is Chromium-only",
    );
    await chatFixture(page);
    const network = { offline: false, reads: 0 };
    await page.route("**/auth/status", (route) => {
      network.reads += 1;
      return network.offline
        ? route.abort("internetdisconnected")
        : route.fulfill({
            json: { configured: true, authenticated: true, canSetup: false },
          });
    });
    await page.goto(baseURL + "/");
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    await page.evaluate(() => localStorage.removeItem("agentpier.signed-in.v1"));
    network.offline = true;
    await context.setOffline(true);
    await page.reload();
    await expect(
      page
        .getByRole("alert")
        .getByText("AgentPier is unreachable. Check that it is running."),
    ).toBeVisible();
    const before = network.reads;
    network.offline = false;
    await context.setOffline(false);
    // The next try comes by itself, without focus or a tap.
    await expect.poll(() => network.reads, { timeout: 10000 }).toBeGreaterThan(before);
    await expect(page.getByRole("alert")).toHaveCount(0);
  },
);
