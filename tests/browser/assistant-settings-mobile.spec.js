import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { setupAssistantSettings } from "../helpers/assistant-settings-browser.js";

const full = { capabilities: { memory: true, reminders: true } };
const scroller = (page) => page.locator(".assistant-settings-scroll");

test.describe("agent settings on phones", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("header and section chips stay put while the settings body scrolls", async ({
    page,
  }) => {
    await setupAssistantSettings(page, { assistant: full });
    await page.goto(baseURL + "/agents/home/settings");
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    await expect(nav).toBeVisible();
    await expect(page.locator(".mobile-header")).toBeHidden();
    const before = await page.evaluate(() => ({
      header: document
        .querySelector(".assistant-settings-page > header")
        .getBoundingClientRect().top,
      nav: document.querySelector(".assistant-section-nav").getBoundingClientRect().top,
    }));
    await scroller(page).evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect
      .poll(() =>
        page.evaluate(() => ({
          header: document
            .querySelector(".assistant-settings-page > header")
            .getBoundingClientRect().top,
          nav: document.querySelector(".assistant-section-nav").getBoundingClientRect()
            .top,
          documentScroll: window.scrollY,
          bodyScrolled:
            document.querySelector(".assistant-settings-scroll").scrollTop > 0,
        })),
      )
      .toEqual({ ...before, documentScroll: 0, bodyScrolled: true });
  });

  test("the profile form is flat and uses the 2e type scale", async ({ page }) => {
    await setupAssistantSettings(page);
    await page.goto(baseURL + "/agents/home/settings");
    const form = page.locator("#agent-profile");
    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
    const style = await form.evaluate((el) => {
      const css = getComputedStyle(el);
      const input = getComputedStyle(el.querySelector("input"));
      const title = getComputedStyle(el.querySelector(".assistant-section-title"));
      // The text box inside a field: what is left after padding; below it the text clips.
      const textBox = (field) => {
        const c = getComputedStyle(field);
        return (
          field.clientHeight - parseFloat(c.paddingTop) - parseFloat(c.paddingBottom)
        );
      };
      const field = el.querySelector("input");
      const select = el.querySelector("select");
      const caps = el.querySelector(".assistant-capability-options");
      return {
        selectHeight: select.offsetHeight === field.offsetHeight,
        selectUnclipped: textBox(select) >= textBox(field),
        capsAligned:
          caps.getBoundingClientRect().left === field.getBoundingClientRect().left,
        border: css.borderTopWidth,
        padding: css.padding,
        inputSize: input.fontSize,
        titleSize: title.fontSize,
        titleWeight: title.fontWeight,
      };
    });
    expect(style).toEqual({
      selectHeight: true,
      selectUnclipped: true,
      capsAligned: true,
      border: "0px",
      padding: "18px 16px",
      inputSize: "16px",
      titleSize: "17px",
      titleWeight: "600",
    });
  });

  test("custom checkboxes keep their native semantics", async ({ page }) => {
    await setupAssistantSettings(page);
    await page.goto(baseURL + "/agents/home/settings");
    const memory = page.getByRole("checkbox", { name: "Remember information" });
    await expect(memory).not.toBeChecked();
    const box = await memory.boundingBox();
    expect(Math.round(box.width)).toBe(18);
    await memory.check();
    await expect(memory).toBeChecked();
    expect(await memory.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      "rgb(244, 154, 88)",
    );
  });

  for (const width of [390, 320])
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 640 });
      await setupAssistantSettings(page, { assistant: full });
      await page.goto(baseURL + "/agents/home/settings");
      await expect(page.locator("#agent-profile")).toBeVisible();
      expect(
        await page.evaluate(() => {
          const el = document.querySelector(".assistant-settings-scroll");
          return (
            document.documentElement.scrollWidth <= innerWidth &&
            el.scrollWidth <= el.clientWidth
          );
        }),
      ).toBe(true);
    });
});
