// AGENTPIER-434: the agent's own browser is reachable while its capability is on, even
// while it does not run: Browser in the chat header (desktop and phone), the ⌘K entry
// "<Agent>'s browser", and the agent's take-over link in its chat, which starts the
// browser and takes control.
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

const home = {
  id: "home",
  name: "Home",
  instructions: "",
  revision: 1,
  effectiveRevision: 1,
  model: { connectionId: "router", modelId: "model" },
  capabilities: { browser: true },
};

async function setup(page, { agent = {}, messages = [] } = {}) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/assistants")
      return route.fulfill({
        json: {
          assistants: [{ ...home, ...agent }],
          conversations: [
            {
              id: "c1",
              assistantId: "home",
              runtimeSessionKey: "k",
              channel: "agentpier",
            },
          ],
          models: [{ id: "router", name: "Router", available: true }],
        },
      });
    if (path === "/api/assistant-runtime")
      return route.fulfill({ json: { availability: "ready", sync: "current" } });
    if (path.endsWith("/messages"))
      return route.fulfill({ json: { messages, requests: [] } });
    return route.fulfill({ json: {} });
  });
  // A stopped browser that "start" brings up; "take" hands control to this viewer.
  const commands = [];
  await page.routeWebSocket("**/api/assistants/home/browser-stream*", (ws) => {
    let status = "stopped";
    let control = { held: false, mine: false };
    const state = () =>
      ws.send(
        JSON.stringify({
          type: "state",
          state: { status, url: "", title: "", targetId: null, tabs: [], control },
        }),
      );
    ws.onMessage((message) => {
      const command = JSON.parse(message);
      commands.push(command);
      if (command.type === "start") status = "live";
      if (command.type === "take") control = { held: true, mine: true, warning: false };
      state();
    });
    state();
  });
  return commands;
}

for (const [label, use] of [
  ["desktop", { viewport: { width: 1280, height: 900 } }],
  [
    "phone 390",
    { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
  ],
  [
    "phone 320",
    { viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true },
  ],
]) {
  test.describe(label, () => {
    test.use(use);

    test("a stopped browser is opened from the chat header and offers to start", async ({
      page,
    }) => {
      const commands = await setup(page);
      await page.goto(baseURL + "/agents/home/chats/c1");
      const entry = page.getByRole("link", { name: "Open Home's browser" });
      await expect(entry).toBeVisible();
      // It fits the header: nothing scrolls sideways, the title stays readable.
      const header = await page.locator(".assistant-header").first().boundingBox();
      const box = await entry.boundingBox();
      expect(box.x + box.width).toBeLessThanOrEqual(header.x + header.width);
      const title = await page.locator(".assistant-header-title").boundingBox();
      expect(title.x + title.width).toBeLessThanOrEqual(box.x);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      await page
        .locator(".assistant-header")
        .first()
        .screenshot({
          path: `.cache/browser-entry-header-${label.replace(" ", "-")}.png`,
        });
      await entry.click();
      await expect(page).toHaveURL(/\/agents\/home\/browser$/);
      await expect(page.getByText("The browser is not running.").first()).toBeVisible();
      await page.getByRole("button", { name: "Start browser" }).click();
      await expect.poll(() => commands).toContainEqual({ type: "start" });
      await expect(page.locator(".agent-browser-status")).toHaveText("Live");
    });
  });
}

test("no browser entry while the capability is off", async ({ page }) => {
  await setup(page, { agent: { capabilities: { browser: false } } });
  await page.goto(baseURL + "/agents/home/chats/c1");
  await expect(page.locator(".assistant-header h1")).toHaveText("Home");
  await expect(page.getByRole("link", { name: "Open Home's browser" })).toHaveCount(0);
});

test("⌘K opens an agent's browser", async ({ page }) => {
  await setup(page);
  // What the search reads beside the agents: nothing.
  await page.route(
    /\/api\/(?:ssh-accesses|mcp-servers|secrets|repositories|pipelines|pipeline-runs|memory\/projects|inbox)(?:\?.*)?$/,
    (route) => route.fulfill({ json: [] }),
  );
  await page.goto(baseURL + "/agents/home/chats/c1");
  await expect(page.getByRole("link", { name: "Open Home's browser" })).toBeVisible();
  const mac = await page.evaluate(() => /mac/i.test(navigator.platform));
  await page.keyboard.press(mac ? "Meta+k" : "Control+k");
  const dialog = page.getByRole("dialog", { name: "Search" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox").fill("Home's browser");
  await dialog.getByRole("option", { name: /^Home's browser/ }).click();
  await expect(page).toHaveURL(/\/agents\/home\/browser$/);
});

test.describe("take-over link", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the agent's sign-in request starts its browser and takes over", async ({
    page,
  }) => {
    const commands = await setup(page, {
      messages: [
        {
          id: "m1",
          role: "assistant",
          text: "Please sign in to Instagram.\n\n[Take over my browser](agentpier:browser-takeover)",
          timestamp: 1,
        },
      ],
    });
    await page.goto(baseURL + "/agents/home/chats/c1");
    const link = page.getByRole("link", { name: "Take over my browser" });
    await expect(link).toHaveAttribute("href", "/agents/home/browser?takeover=1");
    await link.tap();
    // Stopped: the page starts it, then takes control once the picture is live.
    await expect.poll(() => commands).toContainEqual({ type: "start" });
    await expect.poll(() => commands).toContainEqual({ type: "take" });
    await expect(page.getByText("You control the browser.")).toBeVisible();
    await expect(page).toHaveURL(/\/agents\/home\/browser$/);
  });
});
