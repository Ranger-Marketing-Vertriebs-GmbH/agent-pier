import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture, emit } from "../helpers/assistant-chat-fixture.js";

// "Earlier messages" prepends an older history page. While a turn runs, every change
// event reads the latest window again; that read once replaced the whole list, so the
// older messages showed for a moment and vanished (AssistantChat.jsx, agent-history-view.js).
const message = (n, extra = {}) => ({
  id: `m-${n}`,
  role: n % 2 ? "user" : "assistant",
  text: `Message ${n} with enough words to take up a couple of lines in the transcript.`,
  timestamp: n,
  ...extra,
});
const running = (text) => ({
  id: "q-latest",
  state: "accepted",
  text,
  attempt: { id: "a-latest", state: "accepted" },
});

for (const [name, size, touch] of [
  ["desktop", { width: 1440, height: 1000 }, false],
  ["phone", { width: 390, height: 844 }, true],
])
  test.describe(name, () => {
    test.use({ viewport: size, hasTouch: touch, isMobile: touch });

    test("older messages survive live updates of a running turn", async ({ page }) => {
      const older = Array.from({ length: 6 }, (_, n) => message(n));
      const latest = [message(6), message(7)];
      const state = await chatFixture(page, {
        history: {
          messages: latest,
          requests: [running(latest[1].text)],
          nextBefore: "2",
          stale: false,
        },
        olderPages: { 2: { messages: older, nextBefore: null, requests: [] } },
      });
      await page.goto(baseURL + "/agents/home/chats/dinner");
      await expect(page.locator(".assistant-message")).toHaveCount(2);
      await page.getByRole("button", { name: "Earlier messages" }).click();
      await expect(page.locator(".assistant-message")).toHaveCount(8);
      await expect(page.getByRole("button", { name: "Earlier messages" })).toHaveCount(0);

      // The turn goes on: an unchanged window, then one with the new reply.
      await emit(page, { type: "change" });
      state.history = {
        ...state.history,
        messages: [...latest, message(8, { runId: "a-latest" })],
      };
      await emit(page, { type: "change" });
      await expect(page.locator(".assistant-message")).toHaveCount(9);
      await expect(page.locator(".assistant-message").first()).toContainText("Message 0");
      const shown = await page.locator(".assistant-message").allTextContents();
      for (let n = 0; n <= 8; n++) expect(shown[n]).toContain(`Message ${n} with`);
    });

    test("older messages appear above without moving the view", async ({ page }) => {
      const older = Array.from({ length: 30 }, (_, n) => message(n));
      const latest = Array.from({ length: 30 }, (_, n) => message(n + 30));
      await chatFixture(page, {
        history: { messages: latest, requests: [], nextBefore: "30", stale: false },
        olderPages: { 30: { messages: older, nextBefore: null, requests: [] } },
      });
      await page.goto(baseURL + "/agents/home/chats/dinner");
      await expect(page.locator(".assistant-message")).toHaveCount(30);
      const transcript = page.locator(".assistant-transcript");
      await transcript.evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect
        .poll(() => transcript.evaluate((element) => element.scrollTop))
        .toBe(0);
      const boundary = page.locator(".assistant-message").first();
      await expect(boundary).toContainText("Message 30");
      const before = (await boundary.boundingBox()).y;
      await page.getByRole("button", { name: "Earlier messages" }).click();
      await expect(page.locator(".assistant-message")).toHaveCount(60);
      const after = (
        await page
          .locator(".assistant-message")
          .filter({ hasText: "Message 30 with" })
          .boundingBox()
      ).y;
      expect(Math.abs(after - before)).toBeLessThan(80);
      // The newest older message sits right above, in view.
      await expect(
        page.locator(".assistant-message").filter({ hasText: "Message 29 with" }),
      ).toBeInViewport();
    });

    test("a short chat shows the loaded older messages above it", async ({ page }) => {
      const older = Array.from({ length: 20 }, (_, n) => message(n));
      const latest = [message(20), message(21)];
      await chatFixture(page, {
        history: {
          messages: latest,
          requests: [running(latest[1].text)],
          nextBefore: "2",
          stale: false,
        },
        olderPages: { 2: { messages: older, nextBefore: null, requests: [] } },
      });
      await page.goto(baseURL + "/agents/home/chats/dinner");
      await expect(page.locator(".assistant-message")).toHaveCount(2);
      await page.getByRole("button", { name: "Earlier messages" }).click();
      await expect(page.locator(".assistant-message")).toHaveCount(22);
      await expect(
        page.locator(".assistant-message").filter({ hasText: "Message 19 with" }),
      ).toBeInViewport();
      await expect(
        page.locator(".assistant-message").filter({ hasText: "Message 21 with" }),
      ).toBeInViewport();
      await emit(page, { type: "change" });
      await expect(page.locator(".assistant-message")).toHaveCount(22);
    });
  });
