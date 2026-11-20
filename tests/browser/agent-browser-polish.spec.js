import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { decoded, setup } from "../helpers/agent-browser-live-fixture.js";

// AGENTPIER-440: a cold take-over says "Starting", the stopped page says "not
// running" once, a refused address shows by the address bar, the phone header's
// chips are icons instead of cut words, and /agents/<id> opens the main chat.
const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

for (const [label, use] of [
  ["desktop", {}],
  ["phone", phone],
]) {
  test.describe(label, () => {
    test.use(use);

    test("a cold take-over says the browser is starting", async ({ page }) => {
      // The stub keeps the browser stopped after "start": it is still starting.
      const commands = await setup(page, { status: "stopped" });
      await page.goto(baseURL + "/agents/home/browser?takeover=1");
      await expect.poll(() => commands).toContainEqual({ type: "start" });
      await expect(
        page.getByRole("status").filter({ hasText: "Starting the browser …" }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Starting …" })).toBeDisabled();
      await expect(page.getByText("The browser is not running.")).toHaveCount(0);
      await page.screenshot({ path: `.cache/agent-browser-starting-${label}.png` });
    });

    test("a stopped browser says so once", async ({ page }) => {
      await setup(page, { status: "stopped" });
      await page.goto(baseURL + "/agents/home/browser");
      await expect(page.getByRole("button", { name: "Start browser" })).toBeVisible();
      await expect(page.getByText("The browser is not running.")).toHaveCount(1);
    });

    test("a refused address shows by the address bar, above the picture", async ({
      page,
    }) => {
      await setup(page, { control: { held: true, mine: true, warning: false } });
      await page.goto(baseURL + "/agents/home/browser");
      const picture = page.getByRole("img", { name: "Live view of Home's browser" });
      await decoded(picture);
      const address = page.getByLabel("Address");
      await address.fill("http://127.0.0.1:4380/");
      await address.press("Enter");
      const alert = page.getByRole("alert");
      await expect(alert).toContainText("The agent browser may not open this address.");
      const [alertBox, addressBox, pictureBox] = await Promise.all([
        alert.boundingBox(),
        address.boundingBox(),
        picture.boundingBox(),
      ]);
      expect(alertBox.y).toBeGreaterThan(addressBox.y);
      expect(alertBox.y + alertBox.height).toBeLessThanOrEqual(pictureBox.y);
      await expect(alert).toBeInViewport();
    });

    test("the agent's own address opens its main chat", async ({ page }) => {
      await setup(page);
      await page.route("**/api/assistants/home/conversations", (route) =>
        route.fulfill({ json: { id: "c1", assistantId: "home" } }),
      );
      await page.goto(baseURL + "/agents/home");
      await expect(page).toHaveURL(/\/agents\/home\/chats\/c1$/);
      await expect(page.getByText("Page not found")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
    });
  });
}

test.describe("phone header chips", () => {
  test.use(phone);

  // AGENTPIER-440 U6 and AGENTPIER-445: "Shell: full" and "Browser running" were
  // cut to "S…" and "Bro…" on a phone.
  test("are whole icons with their words for screen readers", async ({ page }) => {
    await setup(page, { agent: { shell: "full" } });
    await page.goto(baseURL + "/agents/home/browser");
    const chips = page.locator(".assistant-header .assistant-shell-chip");
    await expect(chips).toHaveCount(2);
    for (const chip of await chips.all()) {
      await expect(chip.locator("svg")).toBeVisible();
      // Nothing cut: the chip is as wide as what it shows.
      expect(
        await chip.evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
    }
    await expect(
      page.getByRole("status").filter({ hasText: "Browser running" }),
    ).toHaveCount(1);
    await expect(chips.first()).toHaveAttribute("title", "Shell access: Full access");
    await page.locator(".assistant-header").screenshot({
      path: ".cache/agent-header-chips-phone.png",
    });
  });
});

test.describe("desktop header chips", () => {
  test("keep their words", async ({ page }) => {
    await setup(page, { agent: { shell: "full" } });
    await page.goto(baseURL + "/agents/home/browser");
    await expect(
      page.locator(".assistant-header .assistant-shell-chip.browser"),
    ).toHaveText("Browser running");
    await expect(
      page.locator(".assistant-header .assistant-shell-chip svg").first(),
    ).toBeHidden();
  });
});
