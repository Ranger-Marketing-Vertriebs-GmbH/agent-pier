// A long session chat with a classic scrollbar (Windows, many Linux desktops): the
// scrollbar takes its width from the messages' padding, so the reading column keeps
// the composer's edges.
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { splitViewFixture } from "../helpers/split-views-browser.js";

// Headless Chromium hides scrollbars unless asked to draw them.
test.use({
  viewport: { width: 1600, height: 1000 },
  launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
});

const box = (locator) => locator.boundingBox();
const near = (actual, expected) => expect(Math.abs(actual - expected)).toBeLessThan(2);

test("a classic scrollbar does not narrow the column of a long chat", async ({
  page,
  browserName,
}) => {
  // WebKit draws no styled classic scrollbar in headless runs; Chromium does.
  test.skip(browserName !== "chromium", "classic scrollbars are forced in Chromium");
  await splitViewFixture(page, {});
  const long = [];
  for (let index = 0; index < 30; index += 1)
    long.push(
      { id: `u${index}`, role: "user", text: `Question ${index}` },
      { id: `a${index}`, role: "assistant", text: `Answer ${index}. `.repeat(40) },
    );
  await page.route("**/api/sessions/s1/chat", (route) =>
    route.fulfill({
      json: {
        availability: "ready",
        providerSessionId: "native-s1",
        messages: long,
        tasks: [],
      },
    }),
  );
  await page.goto(`${baseURL}/sessions/s1/chat`);
  const reply = page.locator(".chat-message:not(.user)").first();
  await expect(reply).toBeVisible();
  // A classic scrollbar, as Windows and many Linux desktops show one.
  await page.addStyleTag({
    content:
      ".chat-messages { scrollbar-width: auto !important; scrollbar-color: auto !important; }" +
      ".chat-messages::-webkit-scrollbar { width: 11px; }",
  });
  const messages = page.locator(".chat-messages");
  await expect
    .poll(() => messages.evaluate((element) => element.offsetWidth - element.clientWidth))
    .toBe(11);
  await expect.poll(async () => (await box(reply)).width).toBe(820);
  const column = await box(reply);
  const bubble = await box(page.locator(".chat-message.user").first());
  near(bubble.x + bubble.width, column.x + column.width);
  const composer = await box(page.locator(".chat-compose-area"));
  near(composer.x, column.x);
  near(composer.x + composer.width, column.x + column.width);
});
