import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { userAgent, userAppFixture } from "../helpers/user-app-fixture.js";

// A restricted user's own order of her agents (agent-order.js), through /api/me only.
const agents = [
  userAgent({ id: "lotta", name: "Lotta", conversationId: "c1" }),
  userAgent({ id: "max", name: "Max", conversationId: "c2" }),
  userAgent({ id: "nora", name: "Nora", conversationId: "c3" }),
];
const names = (page) => page.locator(".user-agents .list-row-label").allTextContents();

test("her ⋯ menu moves an agent up in her own list", async ({ page }) => {
  const state = await userAppFixture(page, { agents });
  await page.goto(baseURL + "/");
  await expect.poll(() => names(page)).toEqual(["Lotta", "Max", "Nora"]);
  await page.getByRole("button", { name: "Actions for Nora", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
  await expect.poll(() => names(page)).toEqual(["Lotta", "Nora", "Max"]);
  await expect.poll(() => state.orders).toEqual([["lotta", "nora", "max"]]);
  await page.reload();
  await expect.poll(() => names(page)).toEqual(["Lotta", "Nora", "Max"]);
  expect(state.foreign).toEqual([]);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a long press and a drag move her agent", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "touch input is dispatched over CDP");
    const state = await userAppFixture(page, { agents });
    await page.goto(baseURL + "/");
    await expect.poll(() => names(page)).toEqual(["Lotta", "Max", "Nora"]);
    const box = async (name) =>
      page.locator(".user-agent-entry").filter({ hasText: name }).boundingBox();
    const from = await box("Nora");
    const to = await box("Lotta");
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, x, y) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x, y }],
      });
    const x = from.x + 60;
    await touch("touchStart", x, from.y + from.height / 2);
    await page.waitForTimeout(700);
    for (let y = from.y + from.height / 2; y > to.y + 6; y -= 12)
      await touch("touchMove", x, y);
    await touch("touchMove", x, to.y + 6);
    await touch("touchEnd");
    await expect.poll(() => names(page)).toEqual(["Nora", "Lotta", "Max"]);
    await expect.poll(() => state.orders).toEqual([["nora", "lotta", "max"]]);
    // The drag opened no chat.
    await expect(page).toHaveURL(baseURL + "/");
  });

  test("a tap still opens the chat", async ({ page }) => {
    const state = await userAppFixture(page, { agents });
    await page.goto(baseURL + "/");
    await page.getByText("Max", { exact: true }).tap();
    await expect(page).toHaveURL(/\/agents\/max/);
    expect(state.orders).toEqual([]);
  });
});
