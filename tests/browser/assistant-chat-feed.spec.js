import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// The agent chat lives on its feed (/api/assistant-conversations/:id/stream); the
// fixture's fake feed (agent-feed-fake.js) pushes the routed history as sync frames.
const message = (n, extra = {}) => ({
  id: `m-${n}`,
  role: n % 2 ? "user" : "assistant",
  text: `Message ${n} with enough words to take up a couple of lines in the transcript.`,
  timestamp: n,
  ...extra,
});
const request = (state) => ({
  id: "q-latest",
  state: state === "completed" ? "completed" : "accepted",
  text: message(7).text,
  attempt: { id: "a-latest", state },
});
const window_ = (from, to, state, nextBefore) => ({
  messages: Array.from({ length: to - from + 1 }, (_, i) =>
    message(from + i, from + i === 8 ? { runId: "a-latest" } : {}),
  ),
  requests: [request(state)],
  nextBefore,
  stale: false,
});
const rows = (page) => page.locator(".assistant-message:not(.streaming)");
const feedReady = (page, count = 1) =>
  page.waitForFunction((n) => window.agentFeed?.sockets.size === n, count);

for (const [name, size, touch] of [
  ["desktop", { width: 1440, height: 1000 }, false],
  ["phone", { width: 390, height: 844 }, true],
])
  test.describe(name, () => {
    test.use({ viewport: size, hasTouch: touch, isMobile: touch });

    test("a streamed turn keeps the earlier messages and shows every row once", async ({
      page,
    }) => {
      const state = await chatFixture(page, {
        history: window_(6, 7, "running", "2"),
        olderPages: {
          2: { messages: [0, 1, 2, 3, 4, 5].map((n) => message(n)), nextBefore: null },
        },
      });
      await page.goto(baseURL + "/agents/home/chats/dinner");
      await expect(rows(page)).toHaveCount(2);
      await page.getByRole("button", { name: "Earlier messages" }).click();
      await expect(rows(page)).toHaveCount(8);
      await feedReady(page);
      await page.evaluate(() => {
        window.agentFeed.stream("dinner", "a-latest", "Message 8 so");
        window.agentFeed.stream("dinner", "a-latest", " far", 12);
      });
      const streaming = page.locator(".assistant-message.streaming");
      await expect(streaming).toContainText("Message 8 so far");
      // The run ends; the window moves on and drops message 6 off its start.
      state.history = window_(7, 8, "completed", "3");
      await page.evaluate(() => window.agentFeed.push("dinner"));
      await expect(rows(page)).toHaveCount(9);
      await expect(streaming).toHaveCount(0);
      const shown = await rows(page).allTextContents();
      for (let n = 0; n <= 8; n++) expect(shown[n]).toContain(`Message ${n} with`);
    });

    test("a dropped feed reconnects with its cursor and catches up", async ({ page }) => {
      const state = await chatFixture(page, { history: window_(6, 7, "running", null) });
      await page.goto(baseURL + "/agents/home/chats/dinner");
      await expect(rows(page)).toHaveCount(2);
      await feedReady(page);
      const cursor = await page.evaluate(() => {
        const [socket] = window.agentFeed.sockets;
        window.agentFeed.drop("dinner");
        return socket.sequence;
      });
      expect(cursor).toBeGreaterThan(0);
      state.history = window_(6, 8, "completed", null);
      await feedReady(page);
      // The new socket names the cursor the chat holds (the fallback read's, or the
      // last frame's), and its sync brings the reply.
      expect(await page.evaluate(() => [...window.agentFeed.sockets][0].cursor)).toMatch(
        /^(?:fake|http)-/,
      );
      await expect(rows(page)).toHaveCount(3);
    });

    test("two tabs follow the same chat on their own feeds", async ({ context }) => {
      const tabs = [];
      for (let i = 0; i < 2; i++) {
        const page = await context.newPage();
        const state = await chatFixture(page, {
          history: window_(6, 7, "running", null),
        });
        await page.goto(baseURL + "/agents/home/chats/dinner");
        await expect(rows(page)).toHaveCount(2);
        await feedReady(page);
        tabs.push({ page, state });
      }
      for (const { page } of tabs)
        await page.evaluate(() =>
          window.agentFeed.stream("dinner", "a-latest", "Typing"),
        );
      for (const { page } of tabs)
        await expect(page.locator(".assistant-message.streaming")).toContainText(
          "Typing",
        );
      for (const { page, state } of tabs) {
        state.history = window_(6, 8, "completed", null);
        await page.evaluate(() => window.agentFeed.push("dinner"));
      }
      for (const { page } of tabs) {
        await expect(rows(page)).toHaveCount(3);
        await expect(page.locator(".assistant-message.streaming")).toHaveCount(0);
      }
    });
  });
