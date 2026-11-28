import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";

test.use({
  locale: "en-GB",
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

// iOS swallows the click of a tap next to the text cursor, and the send button sits
// right below the last line of the message: the finger goes down and up on it, but
// no click follows. The button then answers the tap by itself (web/lib/useTouchTap.js).
async function fixture(page) {
  const session = {
    id: "tap",
    name: "Tap fixture",
    tool: "codex",
    accountId: "local-codex",
    cwd: "/fixture",
    status: "running",
  };
  const chat = { availability: "ready", messages: [], tasks: [] };
  const sent = [];
  await mockChatStream(page, () => chat);
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/input") && request.method() === "POST")
      sent.push(request.postDataJSON());
    return route.fulfill({
      json:
        pathname === "/api/state"
          ? {
              tools: [{ id: "codex", name: "codex", installed: true }],
              accounts: [
                { id: "local-codex", name: "Fixture", tool: "codex", kind: "local" },
              ],
              sessions: [session],
              home: "/fixture",
            }
          : pathname.endsWith("/chat")
            ? chat
            : {},
    });
  });
  await page.goto(baseURL + "/sessions/tap/chat");
  return sent;
}

// A finger down and up on the button, as the page sees it when no click follows.
const touchWithoutClick = (page, selector) =>
  page.locator(selector).evaluate((button) => {
    const box = button.getBoundingClientRect();
    const at = {
      pointerType: "touch",
      pointerId: 5,
      isPrimary: true,
      bubbles: true,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
    };
    button.dispatchEvent(new PointerEvent("pointerdown", at));
    button.dispatchEvent(new PointerEvent("pointerup", at));
  });

test("the send button answers a tap whose click the browser swallowed", async ({
  page,
}) => {
  const sent = await fixture(page);
  const input = page.getByLabel("Message", { exact: true });
  await input.fill("first message");
  await touchWithoutClick(page, ".chat-send");
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].text ?? JSON.stringify(sent[0])).toContain("first message");
  // Nothing follows the one delivery.
  await page.waitForTimeout(600);
  expect(sent).toHaveLength(1);
});

test("an ordinary tap on the send button still sends exactly once", async ({ page }) => {
  const sent = await fixture(page);
  const input = page.getByLabel("Message", { exact: true });
  await input.fill("second message");
  await page.locator(".chat-send").tap();
  await expect.poll(() => sent.length).toBe(1);
  await page.waitForTimeout(600);
  expect(sent).toHaveLength(1);
});
