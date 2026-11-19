import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// The installed app started online, and the connection is gone before the owner opens
// an agent, "Manage all agents" or a session for the first time in this page load:
// their code was loaded in the background (web/app/view-preload.js), so they render
// their shells and offline notices instead of "View unavailable".
const sidebarNote = "Connection lost. Showing the last known agents.";
const chatHint =
  "Connection interrupted. Your draft is preserved; history will refresh when connected.";
const session = {
  id: "one",
  name: "Release notes",
  accountId: "local-claude",
  tool: "claude",
  status: "running",
  cwd: "/fixture",
  createdAt: "2026-09-06T10:00:00Z",
};

async function fixture(page) {
  await chatFixture(page);
  const network = { offline: false };
  await page.route("**/api/state", async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    return route.fulfill({ json: { ...state, sessions: [session] } });
  });
  await page.route("**/auth/status", (route) =>
    route.fulfill({ json: { configured: true, authenticated: true, canSetup: false } }),
  );
  await page.route("**/api/**", (route) =>
    network.offline ? route.abort("internetdisconnected") : route.fallback(),
  );
  await page.routeWebSocket(/\/(chat-stream|terminal)(\?.*)?$/, (socket) =>
    socket.close(),
  );
  return network;
}

// Client-side navigation, as a tap on a link does: no document request.
const open = (page, path) =>
  page.evaluate((target) => {
    window.history.pushState(null, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);

for (const [view, use] of [
  ["desktop", {}],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
])
  test.describe(view, () => {
    test.use(use);
    const phone = view === "phone";

    test("agent pages and sessions never opened online still render offline", async ({
      page,
      context,
      liveStub,
    }) => {
      const network = await fixture(page);
      await page.goto(baseURL + "/");
      await page.waitForFunction(
        () => document.documentElement.dataset.viewPreload === "done",
        null,
        { timeout: 20000 },
      );

      network.offline = true;
      liveStub.refuse();
      await context.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event("offline")));

      await open(page, "/agents/home/chats/dinner");
      await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
      await expect(page.getByText(chatHint)).toBeVisible();
      await expect(page.getByText("View unavailable")).toHaveCount(0);

      // "Manage all agents" lists the last known agents; the sidebar says so.
      await open(page, "/agents");
      const main = page.locator("main");
      await expect(main.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
      await expect(main.getByText("Home assistant").first()).toBeVisible();
      await expect(page.getByText(sidebarNote).first()).toBeAttached();
      await expect(page.getByText("View unavailable")).toHaveCount(0);

      // A session opens in its default mode: the terminal on a desktop, the chat on a
      // phone, both waiting for the connection.
      await open(page, "/sessions/one");
      await expect(
        main.getByRole("heading", { name: "Release notes", level: 1 }),
      ).toBeVisible();
      await expect(main.getByText("Disconnected · retrying …")).toBeVisible();
      await expect(
        phone
          ? main.getByRole("region", { name: "Chat" }).getByLabel("Message")
          : main.getByLabel("Terminal input"),
      ).toBeAttached();
      await expect(page.getByText("View unavailable")).toHaveCount(0);
      await context.setOffline(false);
    });
  });
