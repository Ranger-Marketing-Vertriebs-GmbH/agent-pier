import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./ssh-fixture.js";
import { showKeys } from "./ssh-settings-helpers.js";

// Phone bottom sheets (Modal, Sheet) close when their grab handle is dragged down
// (web/components/useSheetDrag.js), through the same path as Escape.
test.use({
  locale: "en-GB",
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

async function openGallery(page, opener, title) {
  if (!page.url().endsWith("/settings/components"))
    await page.goto("/settings/components");
  await page.getByRole("button", { name: opener, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog).toBeVisible();
  return dialog;
}

// A point on the grab handle: the top of the heading, clear of the close button.
async function handle(dialog) {
  const box = await dialog.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + 10 };
}

async function mouseDrag(page, from, dy, { hold = 0 } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y + dy, { steps: 12 });
  if (hold) await page.waitForTimeout(hold);
  await page.mouse.up();
}

// Real touch input (Chromium only), so touch-action and native scrolling take part.
async function touchDrag(page, from, dy) {
  const cdp = await page.context().newCDPSession(page);
  const point = (y) => [{ x: from.x, y }];
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: point(from.y),
  });
  for (let step = 1; step <= 12; step += 1)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: point(from.y + (dy * step) / 12),
    });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

const transform = (dialog) => dialog.evaluate((element) => element.style.transform);

test("dragging a Modal's handle down closes it", async ({ page }) => {
  const dialog = await openGallery(page, "Open Modal", "Modal");
  await mouseDrag(page, await handle(dialog), 300);
  await expect(dialog).toBeHidden();
});

test("dragging a Sheet's handle down cancels it", async ({ page }) => {
  const dialog = await openGallery(page, "Open Sheet", "Sheet");
  await mouseDrag(page, await handle(dialog), 250);
  await expect(dialog).toBeHidden();
});

test("a short, slow drag lets the sheet snap back", async ({ page }) => {
  for (const [opener, title] of [
    ["Open Modal", "Modal"],
    ["Open Sheet", "Sheet"],
  ]) {
    const dialog = await openGallery(page, opener, title);
    // 30% of the small gallery Modal is about 40px.
    await mouseDrag(page, await handle(dialog), 24, { hold: 250 });
    await expect(dialog).toBeVisible();
    await expect.poll(() => transform(dialog)).toBe("");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
});

test("the close button still closes after the handle zone takes touches", async ({
  page,
}) => {
  const dialog = await openGallery(page, "Open Modal", "Modal");
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).tap();
  await expect(dialog).toBeHidden();
});

test("a busy Modal whose close button is disabled stays open", async ({ page }) => {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.goto(baseURL + "/settings/ssh");
  await showKeys(page);
  await page.getByRole("button", { name: "Add SSH key", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const name = dialog.getByLabel("Name", { exact: true });
  await name.fill("Unsaved deployment key");
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/ssh-keys", async (route) => {
    await pending;
    await route.fulfill({ status: 409, json: { error: "Fixture conflict" } });
  });
  try {
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Close dialog" })).toBeDisabled();
    await mouseDrag(page, await handle(dialog), 400);
    await expect(dialog).toBeVisible();
    await expect.poll(() => transform(dialog)).toBe("");
    await expect(name).toHaveValue("Unsaved deployment key");
  } finally {
    release();
  }
  await expect(dialog.getByRole("alert")).toContainText("Fixture conflict");
  await mouseDrag(page, await handle(dialog), 400);
  await expect(dialog).toBeHidden();
});

test.describe("touch on the body", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "CDP touch input");

  async function tallModal(page) {
    const dialog = await openGallery(page, "Open Modal with footer", "Modal with footer");
    await dialog.locator(".dialog-body").evaluate((body) => {
      const filler = document.createElement("div");
      filler.style.height = "1600px";
      body.append(filler);
    });
    return dialog;
  }

  test("a touch drag on the handle closes the sheet", async ({ page }) => {
    const dialog = await openGallery(page, "Open Sheet", "Sheet");
    await touchDrag(page, await handle(dialog), 260);
    await expect(dialog).toBeHidden();
  });

  test("a downward drag on content scrolled to the top closes the sheet", async ({
    page,
  }) => {
    const dialog = await tallModal(page);
    const body = await dialog.locator(".dialog-body p").boundingBox();
    await touchDrag(page, { x: body.x + 20, y: body.y + 5 }, 300);
    await expect(dialog).toBeHidden();
  });

  test("a downward drag on scrolled content scrolls it instead", async ({ page }) => {
    const dialog = await tallModal(page);
    await dialog.evaluate((element) => (element.scrollTop = 600));
    const box = await dialog.boundingBox();
    await touchDrag(page, { x: box.x + 40, y: box.y + box.height / 2 }, 300);
    await expect(dialog).toBeVisible();
    expect(await transform(dialog)).toBe("");
    await expect
      .poll(() => dialog.evaluate((element) => element.scrollTop))
      .toBeLessThan(600);
  });
});
