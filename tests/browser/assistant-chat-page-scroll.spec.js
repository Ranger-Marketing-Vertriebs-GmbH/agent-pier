import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// The agent chat is a fixed-height view: only the transcript scrolls. Hidden
// speaker labels of user messages are absolutely positioned and once escaped the
// transcript's clip, so a long conversation made the whole page scroll.
const message = (n) => ({
  id: `m-${n}`,
  role: n % 2 ? "user" : "assistant",
  text: `Message ${n} with enough words to take up a couple of lines in the transcript.`,
});
const conversations = {
  long: Array.from({ length: 40 }, (_, n) => message(n)),
  short: [message(0), message(1)],
};

for (const [name, size, touch] of [
  ["desktop", { width: 1440, height: 1000 }, false],
  ["phone", { width: 390, height: 844 }, true],
])
  test.describe(name, () => {
    test.use({ viewport: size, hasTouch: touch, isMobile: touch });

    for (const [length, messages] of Object.entries(conversations))
      test(`the page does not scroll with a ${length} conversation`, async ({ page }) => {
        await chatFixture(page, { history: { messages, requests: [], stale: false } });
        await page.goto(baseURL + "/agents/home/chats/dinner");
        const composer = page.locator(".assistant-composer");
        await expect(composer.locator("textarea")).toBeVisible();
        await expect(page.locator(".assistant-message")).toHaveCount(messages.length);
        const measured = await page.evaluate(() => {
          scrollTo(0, document.scrollingElement.scrollHeight);
          return {
            scrollHeight: document.scrollingElement.scrollHeight,
            scrollY,
            height: innerHeight,
          };
        });
        expect(measured.scrollHeight).toBe(measured.height);
        expect(measured.scrollY).toBe(0);
        const box = await composer.boundingBox();
        expect(Math.round(box.y + box.height)).toBe(size.height);
      });
  });
