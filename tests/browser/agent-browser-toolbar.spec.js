import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { setup } from "../helpers/agent-browser-live-fixture.js";

// The takeover's browser toolbar (BrowserToolbar.jsx): read-only while watching; the
// holder navigates, goes back, reloads, and switches and closes tabs. The stub stream
// answers like the server, pushing the new address and tabs.

for (const [label, use] of [
  ["desktop", {}],
  ["phone", { viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true }],
]) {
  test.describe(`${label} browser toolbar`, () => {
    test.use(use);

    test("the holder navigates, goes back, reloads and switches tabs", async ({
      page,
    }) => {
      const commands = await setup(page);
      await page.goto(baseURL + "/agents/home/browser");
      const address = page.getByLabel("Address");
      await expect(address).toHaveValue("https://shop.example/");
      // Watching: everything is read-only, and the tab choice only picks the view.
      await expect(address).not.toBeEditable();
      for (const name of ["Back", "Forward", "Reload", "Stop loading"])
        await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Close tab" })).toHaveCount(0);

      await page.getByRole("button", { name: "Take over", exact: true }).click();
      await expect(page.getByText("You control the browser.")).toBeVisible();
      await expect(address).toBeEditable();
      await address.fill("news.example");
      await address.press("Enter");
      await expect
        .poll(() => commands)
        .toContainEqual({ type: "navigate", action: "go", url: "news.example" });
      // The stream pushes the new address.
      await expect(address).toHaveValue("https://news.example/");

      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect
        .poll(() => commands)
        .toContainEqual({ type: "navigate", action: "back" });
      await expect(address).toHaveValue("https://shop.example/");
      await page.getByRole("button", { name: "Reload", exact: true }).click();
      await expect
        .poll(() => commands)
        .toContainEqual({ type: "navigate", action: "reload" });

      // The sign-in tab: switched to in the agent's browser, then closed.
      await page.getByLabel("Tab", { exact: true }).selectOption("t2");
      await expect
        .poll(() => commands)
        .toContainEqual({ type: "tab", action: "switch", targetId: "t2" });
      await expect(address).toHaveValue("https://shop.example/cart");
      await page.getByRole("button", { name: "Close tab" }).click();
      await expect
        .poll(() => commands)
        .toContainEqual({ type: "tab", action: "close", targetId: "t2" });
      // One tab left: no switcher.
      await expect(page.getByLabel("Tab", { exact: true })).toHaveCount(0);
      await expect(address).toHaveValue("https://shop.example/");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    });

    test("an address the agent browser may not open is refused with the reason", async ({
      page,
    }) => {
      await setup(page, { control: { held: true, mine: true, warning: false } });
      await page.goto(baseURL + "/agents/home/browser");
      const address = page.getByLabel("Address");
      await address.fill("http://127.0.0.1:4380/");
      await address.press("Enter");
      await expect(page.getByRole("alert")).toContainText(
        "The agent browser may not open this address.",
      );
      // The page's own address comes back once the field is left.
      await address.press("Escape");
      await expect(address).toHaveValue("https://shop.example/");
    });
  });
}

test.describe("phone browser toolbar at 320px", () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true });

  test("icon buttons keep 44px targets and the address fits", async ({ page }) => {
    await setup(page, { control: { held: true, mine: true, warning: false } });
    await page.goto(baseURL + "/agents/home/browser");
    const address = page.getByLabel("Address");
    await expect(address).toBeEditable();
    for (const name of ["Back", "Forward", "Reload", "Stop loading", "Close tab"]) {
      const box = await page.getByRole("button", { name, exact: true }).boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const box = await address.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(box.width).toBeGreaterThan(200);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await page.locator(".agent-browser-toolbar").screenshot({
      path: ".cache/browser-toolbar-phone.png",
    });
  });
});
