import { test, expect, devices } from "@playwright/test";
import { fulfillDormantAssistantRequest } from "../helpers/assistant-browser-fixture.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { baseURL } from "../helpers/browser.js";

// The composer measures its grown field by collapsing it for a moment. WebKit then
// clamps the transcript's scrollTop and, without scroll anchoring, never restores it:
// the newest lines stay hidden behind the composer. Chromium hides the bug behind
// scroll anchoring, so the page turns anchoring off to catch it there too.
const { defaultBrowserType: _browser, ...iphone } = devices["iPhone 13"];
const draft =
  "This is a longer draft that wraps onto a second and then a third line in the " +
  "composer box while the owner keeps typing slowly";

// Distance from the scroller's bottom in every frame, as painted: a ResizeObserver
// registered after the app's own observer sees the frame after its correction.
async function sampleBottomGap(page, selector) {
  await page.addStyleTag({ content: "* { overflow-anchor: none !important; }" });
  await page.evaluate((selector) => {
    const scroller = document.querySelector(selector);
    const gap = () =>
      Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight);
    window.bottomGaps = [];
    const frame = () => {
      window.bottomGaps.push(gap());
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    new ResizeObserver(() => {
      if (window.bottomGaps.length)
        window.bottomGaps[window.bottomGaps.length - 1] = gap();
    }).observe(scroller);
  }, selector);
}

async function typeAndCollect(page, field) {
  await field.click();
  await field.pressSequentially(draft, { delay: 20 });
  await page.waitForTimeout(500);
  const gaps = await page.evaluate(() => window.bottomGaps);
  expect(gaps.length).toBeGreaterThan(10);
  return gaps.filter((gap) => gap > 1);
}

const messages = Array.from({ length: 24 }, (_, i) => ({
  id: `m${i}`,
  role: i % 2 ? "assistant" : "user",
  text: `Message ${i} with enough words to wrap a line or two on a phone screen here.`,
}));

for (const [name, use] of [
  ["phone", iphone],
  ["desktop", { viewport: { width: 1280, height: 800 } }],
]) {
  test.describe(`agent chat composer on ${name}`, () => {
    test.use(use);

    test("typing a wrapping draft keeps the run state in view", async ({ page }) => {
      await chatFixture(page, {
        history: {
          messages,
          requests: [
            { id: "r1", text: "Message 22", attempt: { id: "a1", state: "completed" } },
          ],
          stale: false,
        },
      });
      await page.goto(baseURL + "/agents/home/chats/dinner");
      await expect(page.locator(".assistant-run-state")).toHaveText("Completed");
      await sampleBottomGap(page, ".assistant-transcript");
      expect(await typeAndCollect(page, page.locator("#assistant-message"))).toEqual([]);
      await expect(page.locator(".chat-jump-bottom")).toHaveCount(0);
    });
  });
}

test.describe("session chat composer on phone", () => {
  test.use(iphone);

  test("typing a wrapping draft keeps the latest message in view", async ({ page }) => {
    const session = {
      id: "scroll",
      name: "Scroll session",
      accountId: "local-codex",
      tool: "codex",
      cwd: "/fixture/projects/website",
      status: "running",
      activity: { state: "idle" },
    };
    const data = { availability: "ready", messages, tasks: [] };
    await mockChatStream(page, () => data);
    await page.route("**/api/**", async (route) => {
      if (await fulfillDormantAssistantRequest(route)) return;
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/state")
        return route.fulfill({
          json: {
            tools: [{ id: "codex", name: "Codex", installed: true }],
            accounts: [
              { id: "local-codex", name: "Codex", tool: "codex", kind: "local" },
            ],
            sessions: [session],
            home: "/fixture",
          },
        });
      if (path.endsWith("/chat")) return route.fulfill({ json: data });
      if (path.endsWith("/models"))
        return route.fulfill({
          json: { currentModel: null, picker: null, pending: false },
        });
      return route.fulfill({ json: {} });
    });
    await page.goto(baseURL + "/sessions/scroll/chat");
    await expect(page.locator(".chat-messages")).toContainText("Message 23");
    await sampleBottomGap(page, ".chat-messages");
    expect(await typeAndCollect(page, page.locator(".chat-composer textarea"))).toEqual(
      [],
    );
  });
});
