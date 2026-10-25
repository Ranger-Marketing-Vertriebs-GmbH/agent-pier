import { test, expect, devices } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// A long chat opens at its newest message and stays there while its history arrives
// late and its images grow the transcript after the first scroll to the end; a reader
// who scrolls up before that keeps the place (AGENTPIER-241, transcript-scroll.js).
const { defaultBrowserType: _browser, ...iphone } = devices["iPhone 13"];
const image = (n) => ({
  id: `photo-${n}`,
  name: `photo-${n}.svg`,
  type: "image/svg+xml",
  kind: "image",
  size: 120,
});
const messages = Array.from({ length: 40 }, (_, n) => ({
  id: `m${n}`,
  role: n % 2 ? "assistant" : "user",
  text: `Message ${n} with enough words to wrap a line or two on a phone screen here.`,
  // The newest messages carry images: they are the ones in view once the chat opens.
  ...(n % 2 === 0 && n > 30 ? { attachments: [image(n)] } : {}),
}));
const tall =
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="480">' +
  '<rect width="320" height="480" fill="#888"/></svg>';

const bottomGap = (page) =>
  page
    .locator(".assistant-transcript")
    .evaluate((e) => Math.round(e.scrollHeight - e.scrollTop - e.clientHeight));

// Holds the history and every image until the test releases them.
async function slowChat(page) {
  await chatFixture(page, {
    history: { messages, requests: [], stale: false },
  });
  let releaseHistory;
  const history = new Promise((resolve) => (releaseHistory = resolve));
  let releaseImages;
  const images = new Promise((resolve) => (releaseImages = resolve));
  await page.route(/\/api\/assistant-conversations\/dinner\/messages/, async (route) => {
    if (route.request().method() === "GET") await history;
    await route.fallback();
  });
  await page.route(/\/api\/assistant-attachments\//, async (route) => {
    await images;
    await route.fulfill({ status: 200, contentType: "image/svg+xml", body: tall });
  });
  return { releaseHistory, releaseImages };
}

// A wheel turn on desktop. Mobile WebKit has no wheel and Playwright no touch drag,
// so the phone replays a drag's events around the scroll it makes.
async function scrollUp(page, isMobile) {
  const transcript = page.locator(".assistant-transcript");
  if (!isMobile) {
    await transcript.hover();
    return page.mouse.wheel(0, -600);
  }
  await transcript.evaluate(async (element) => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    element.dispatchEvent(new Event("touchstart", { bubbles: true }));
    for (let step = 0; step < 6; step += 1) {
      element.scrollTop -= 100;
      await frame();
    }
    window.dispatchEvent(new Event("touchend"));
  });
}

async function imagesLoaded(page) {
  await expect
    .poll(() =>
      page
        .locator(".assistant-transcript img")
        .evaluateAll((all) => all.filter((i) => i.complete && i.naturalWidth).length),
    )
    .toBeGreaterThan(0);
  // One more frame for the transcript to settle after the last image.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
}

for (const [name, use] of [
  ["phone", iphone],
  ["desktop", { viewport: { width: 1280, height: 800 } }],
])
  test.describe(`agent chat opening on ${name}`, () => {
    test.use(use);

    test("a slow long chat ends at the newest message", async ({ page }) => {
      const { releaseHistory, releaseImages } = await slowChat(page);
      await page.goto(baseURL + "/agents/home/chats/dinner");
      await page.waitForTimeout(300);
      releaseHistory();
      await expect(page.getByText("Message 39 with")).toBeAttached();
      // A scroll the page makes by itself (WebKit clamping it while the composer or
      // the keyboard resizes) is no reader's move: the chat still follows its end.
      await page
        .locator(".assistant-transcript")
        .evaluate((element) => (element.scrollTop -= 300));
      await page.waitForTimeout(300);
      releaseImages();
      await imagesLoaded(page);
      await expect.poll(() => bottomGap(page)).toBeLessThan(2);
      await expect(page.getByText("Message 39 with")).toBeInViewport();
      await expect(page.locator(".chat-jump-bottom")).toHaveCount(0);
    });

    test("scrolling up before the images load keeps the place", async ({
      page,
      isMobile,
    }) => {
      const { releaseHistory, releaseImages } = await slowChat(page);
      await page.goto(baseURL + "/agents/home/chats/dinner");
      releaseHistory();
      await expect(page.getByText("Message 39 with")).toBeInViewport();
      await scrollUp(page, isMobile);
      await expect.poll(() => bottomGap(page)).toBeGreaterThan(300);
      releaseImages();
      await imagesLoaded(page);
      await page.waitForTimeout(200);
      expect(await bottomGap(page)).toBeGreaterThan(300);
      await expect(page.locator(".chat-jump-bottom")).toBeVisible();
    });
  });
