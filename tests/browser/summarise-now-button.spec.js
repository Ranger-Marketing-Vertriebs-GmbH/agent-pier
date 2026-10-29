import { test, expect } from "../helpers/browser-test.js";
import { stubContext } from "../helpers/live-stub.js";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// Summarize now in the owner's chat bar at any time (AGENTPIER-263): the same action
// as the long-chat hint, disabled with a reason while a turn or a summary runs.
const messages = [
  { id: "u0", role: "user", text: "Plan three dinners.", timestamp: 1, requestId: "q0" },
  { id: "a0", role: "assistant", text: "Here they are.", timestamp: 2, runId: "t0" },
];
const request = (state) => ({
  id: "q0",
  state,
  text: messages[0].text,
  attempt: { id: "t0", state },
});
const idle = { messages, requests: [request("completed")], stale: false };
const synced = (page) => page.waitForFunction(() => window.agentFeed?.synced("dinner"));
const button = (page) =>
  page.locator(".agent-chat-bar").getByRole("button", {
    name: "Summarize now",
  });

test("Summarize now works outside the long-chat state and waits while a turn runs", async ({
  page,
}) => {
  const state = await chatFixture(page, { history: idle });
  const compacts = [];
  await page.route("**/api/assistant-conversations/dinner/compact", async (route) => {
    compacts.push(route.request().method());
    state.history = { ...idle, compacting: true };
    await page.evaluate(() => window.agentFeed.push("dinner"));
    await route.fulfill({ json: { compacted: false, running: true } });
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await synced(page);
  await expect(page.locator(".assistant-long-chat")).toHaveCount(0);
  await expect(button(page)).toBeEnabled();
  if (process.env.SUMMARISE_SCREENSHOT)
    await page.screenshot({
      path: process.env.SUMMARISE_SCREENSHOT,
      clip: { x: 0, y: 0, width: 1440, height: 130 },
    });

  // A running turn disables it and says why.
  state.history = { ...idle, requests: [request("running")] };
  await page.evaluate(() => window.agentFeed.push("dinner"));
  await expect(button(page)).toBeDisabled();
  await expect(button(page)).toHaveAttribute(
    "title",
    "Not possible while the agent is working.",
  );

  // Idle again: one click sends one request, and the summary shows as running.
  state.history = idle;
  await page.evaluate(() => window.agentFeed.push("dinner"));
  await expect(button(page)).toBeEnabled();
  await button(page).click();
  await expect(page.locator(".assistant-run-state")).toContainText("Summarising");
  await expect(button(page)).toBeDisabled();
  await expect(button(page)).toHaveAttribute("title", "A summary is already running.");
  expect(compacts).toEqual(["POST"]);
});

test("Summarize now waits for a first message and fits a phone", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  await stubContext(context);
  const page = await context.newPage();
  await chatFixture(page, { history: { messages: [], requests: [], stale: false } });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await synced(page);
  await expect(button(page)).toBeDisabled();
  await expect(button(page)).toHaveAttribute("title", "Nothing to summarise yet.");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await context.close();
});
