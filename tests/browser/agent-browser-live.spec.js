import { test, expect } from "@playwright/test";
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
  browserRunning: true,
};
// One frame as OpenClaw sends it: header length, JSON header, JPEG bytes.
function frame() {
  const header = Buffer.from(
    JSON.stringify({ url: "https://shop.example/", cssWidth: 800 }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([length, header, Buffer.from([0xff, 0xd8, 0xff, 0xd9])]);
}
const tabs = [
  { targetId: "t1", title: "Shop", url: "https://shop.example/" },
  { targetId: "t2", title: "Cart", url: "https://shop.example/cart" },
];

async function setup(page, { status = "live" } = {}) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    if (path === "/api/assistants")
      return route.fulfill({
        json: {
          assistants: [home],
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
      return route.fulfill({
        json: {
          availability: "ready",
          sync: "current",
          browser: {
            available: true,
            name: "Chrome for Testing",
            visible: { available: true },
          },
        },
      });
    if (path.endsWith("/messages"))
      return route.fulfill({ json: { messages: [], requests: [] } });
    return route.fulfill({ json: {} });
  });
  const commands = [];
  await page.routeWebSocket("**/api/assistants/home/browser-stream*", (ws) => {
    ws.onMessage((message) => commands.push(JSON.parse(message)));
    ws.send(
      JSON.stringify({
        type: "state",
        state: {
          status,
          url: "https://shop.example/",
          title: "Shop",
          targetId: "t1",
          tabs,
        },
      }),
    );
    if (status === "live") ws.send(frame());
  });
  return commands;
}

for (const [label, use] of [
  ["desktop", {}],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
]) {
  test.describe(label, () => {
    test.use(use);

    test("the live view shows the agent's browser, its address and tabs", async ({
      page,
    }) => {
      const commands = await setup(page);
      await page.goto(baseURL + "/agents/home/browser");
      await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();
      await expect(
        page.getByText("https://shop.example/", { exact: true }),
      ).toBeVisible();
      const picture = page.getByRole("img", { name: "Live view of Home's browser" });
      await expect(picture).toHaveAttribute("src", /^blob:/);
      await page.getByLabel("Tab").selectOption("t2");
      await expect
        .poll(() => commands)
        .toContainEqual({ type: "select", targetId: "t2" });
      await expect(page.getByText("AgentPier stores no pictures")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    });

    test("a stopped browser can be started from the live view", async ({ page }) => {
      const commands = await setup(page, { status: "stopped" });
      await page.goto(baseURL + "/agents/home/browser");
      await expect(page.getByText("The browser is not running.").first()).toBeVisible();
      await page.getByRole("button", { name: "Start browser" }).click();
      await expect.poll(() => commands).toContainEqual({ type: "start" });
    });
  });
}

test("the agent settings open the live view", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/agents/home/settings?tab=capabilities");
  await page.getByRole("link", { name: /Open live view/ }).click();
  await expect(page).toHaveURL(/\/agents\/home\/browser$/);
  await expect(
    page.getByRole("img", { name: "Live view of Home's browser" }),
  ).toBeVisible();
});

test("the chat header shows a live preview while the browser runs", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/agents/home/chats/c1");
  const preview = page.getByRole("link", { name: "Live view of Home's browser" });
  await expect(preview).toBeVisible();
  await expect(preview.locator("img")).toHaveAttribute("src", /^blob:/);
  await preview.click();
  await expect(page).toHaveURL(/\/agents\/home\/browser$/);
});
