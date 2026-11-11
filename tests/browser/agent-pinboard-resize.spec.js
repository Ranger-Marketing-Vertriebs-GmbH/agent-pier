import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// The docked pinboard's divider (DockedPanel `resizeKey`): drag and arrow keys widen
// it within bounds (never below its default, the chat keeps 360px), a double-click
// resets it, and the width is remembered per browser. Phones have no divider.
const view = {
  fresh: 0,
  lists: [
    {
      id: "notes",
      title: "Notes",
      description: "",
      origin: null,
      archived: false,
      updatedAt: "2026-11-07T10:00:00.000Z",
      entries: [
        {
          id: "n1",
          name: "long.md",
          note: "",
          kind: "text",
          size: 10,
          state: "ok",
          fresh: false,
        },
      ],
    },
  ],
};
const DEFAULT = 380;
const CHAT_MIN = 360;

async function open(page) {
  await chatFixture(page, {
    conversations: [{ id: "dinner", assistantId: "home", title: "Dinner plans" }],
    language: "en",
  });
  await page.route("**/api/assistants/home/pinboard", (route) =>
    route.fulfill({ json: view }),
  );
  await page.goto(baseURL + "/agents/home/chats/dinner?pinboard=1");
  await expect(page.locator(".pinboard-list").first()).toBeVisible();
}

const width = async (locator) => (await locator.boundingBox()).width;

test.describe("desktop", () => {
  test.use({ viewport: { width: 1369, height: 900 } });

  test("drag, keys and double-click resize the pinboard within bounds", async ({
    page,
  }) => {
    await open(page);
    const panel = page.getByRole("complementary", { name: "Pinboard" });
    const divider = page.getByRole("separator", { name: "Resize panel" });
    await expect(divider).toHaveAttribute("aria-orientation", "vertical");
    await expect(divider).toHaveAttribute("aria-valuenow", String(DEFAULT));
    await expect(divider).toHaveAttribute("aria-valuemin", String(DEFAULT));
    expect(Math.round(await width(panel))).toBe(DEFAULT);
    const body = await page.locator(".assistant-chat-body").boundingBox();
    const max = Math.round(body.width - CHAT_MIN);
    await expect(divider).toHaveAttribute("aria-valuemax", String(max));

    // Drag 200px to the left: the panel grows by 200px.
    const handle = await divider.boundingBox();
    const x = handle.x + handle.width / 2,
      y = handle.y + handle.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 100, y, { steps: 4 });
    await page.mouse.move(x - 200, y, { steps: 4 });
    await page.mouse.up();
    await expect(divider).toHaveAttribute("aria-valuenow", String(DEFAULT + 200));
    expect(Math.round(await width(panel))).toBe(DEFAULT + 200);

    // Far past either end: the bounds hold, the chat keeps its minimum.
    const now = await divider.boundingBox();
    await page.mouse.move(now.x + 4, y);
    await page.mouse.down();
    await page.mouse.move(body.x - 200, y, { steps: 6 });
    await page.mouse.up();
    await expect(divider).toHaveAttribute("aria-valuenow", String(max));
    const chat = page.locator(".assistant-chat-body > .assistant-chat-panel");
    expect(await width(chat)).toBeGreaterThanOrEqual(CHAT_MIN - 1);
    const wide = await divider.boundingBox();
    await page.mouse.move(wide.x + 4, y);
    await page.mouse.down();
    await page.mouse.move(body.x + body.width + 100, y, { steps: 6 });
    await page.mouse.up();
    await expect(divider).toHaveAttribute("aria-valuenow", String(DEFAULT));

    // Keyboard: Left widens, Right narrows, End and Home jump to the bounds.
    await divider.focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(divider).toHaveAttribute("aria-valuenow", String(DEFAULT + 48));
    await page.keyboard.press("ArrowRight");
    await expect(divider).toHaveAttribute("aria-valuenow", String(DEFAULT + 24));
    await page.keyboard.press("End");
    await expect(divider).toHaveAttribute("aria-valuenow", String(max));
    await page.keyboard.press("Home");
    await expect(divider).toHaveAttribute("aria-valuenow", String(DEFAULT));

    // Remembered across a reload; a double-click returns to the default.
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(divider).toHaveAttribute("aria-valuenow", String(DEFAULT + 72));
    await page.reload();
    await expect(divider).toHaveAttribute("aria-valuenow", String(DEFAULT + 72));
    expect(Math.round(await width(panel))).toBe(DEFAULT + 72);
    await divider.dblclick();
    await expect(divider).toHaveAttribute("aria-valuenow", String(DEFAULT));
    await page.reload();
    await expect(divider).toHaveAttribute("aria-valuenow", String(DEFAULT));
  });

  test("a remembered width shrinks with a narrower window", async ({ page }) => {
    await open(page);
    const divider = page.getByRole("separator", { name: "Resize panel" });
    await divider.focus();
    await page.keyboard.press("End");
    await page.setViewportSize({ width: 1100, height: 900 });
    const body = await page.locator(".assistant-chat-body").boundingBox();
    await expect(divider).toHaveAttribute(
      "aria-valuenow",
      String(Math.max(DEFAULT, Math.round(body.width - CHAT_MIN))),
    );
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the Chat | Pinboard switch has no divider", async ({ page }) => {
    await open(page);
    await expect(page.locator(".pinboard-list").first()).toBeVisible();
    await expect(page.getByRole("separator", { name: "Resize panel" })).toHaveCount(0);
    await expect(page.locator(".docked-panel")).toHaveCount(0);
  });
});
