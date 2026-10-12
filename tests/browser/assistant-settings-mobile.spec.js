import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { setupAssistantSettings } from "../helpers/assistant-settings-browser.js";

const full = { capabilities: { memory: true, reminders: true } };
const bar = (page) => page.locator(".assistant-save-bar");
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

  test("selects show the 16px handoff chevron 12px from the edge", async ({ page }) => {
    await setupAssistantSettings(page);
    await page.goto(baseURL + "/agents/home/settings");
    const select = page.locator("#agent-profile select").first();
    await expect(select).toBeVisible();
    const style = await select.evaluate((el) => {
      const css = getComputedStyle(el);
      return {
        appearance: css.appearance,
        chevron: css.backgroundImage.startsWith('url("data:image/svg+xml'),
        size: css.backgroundSize,
        // Engines serialise "right 12px center" differently.
        position: /^(calc\(100% - 12px\) 50%|right 12px (center|top 50%))$/.test(
          css.backgroundPosition,
        ),
        paddingRight: css.paddingRight,
      };
    });
    expect(style).toEqual({
      appearance: "none",
      chevron: true,
      size: "16px 16px",
      position: true,
      paddingRight: "40px",
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

  test("the chip of the section in view is active", async ({ page }) => {
    await setupAssistantSettings(page, { assistant: full });
    await page.goto(baseURL + "/agents/home/settings");
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    const current = nav.locator('a[aria-current="location"]');
    await expect(current).toHaveText("Profile");
    await page
      .locator("#agent-memory")
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    await expect(current).toHaveText("Memory");
    await expect(current).toHaveCount(1);
    // Chips fade between states, so wait for the transition to settle.
    await expect
      .poll(() =>
        current.evaluate((el) => {
          const css = getComputedStyle(el);
          return { color: css.color, background: css.backgroundColor };
        }),
      )
      .toEqual({ color: "rgb(255, 201, 157)", background: "rgb(48, 38, 28)" });
  });

  test("the last section becomes active when the scroller reaches its end", async ({
    page,
  }) => {
    await setupAssistantSettings(page, { assistant: full });
    await page.goto(baseURL + "/agents/home/settings");
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    await expect(nav.locator('a[aria-current="location"]')).toHaveText("Profile");
    await scroller(page).evaluate((el) => (el.scrollTop = el.scrollHeight));
    const current = nav.locator('a[aria-current="location"]');
    await expect(current).toHaveText("Telegram for others");
    await expect(current).toHaveCount(1);
  });

  test("clicking a chip activates it at once and keeps it in the chip row", async ({
    page,
  }) => {
    await setupAssistantSettings(page, { assistant: full });
    await page.goto(baseURL + "/agents/home/settings");
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    const telegram = nav.getByRole("link", { name: "Telegram", exact: true });
    await telegram.click();
    await expect(telegram).toHaveAttribute("aria-current", "location");
    await expect(
      page.getByRole("heading", { name: "Telegram", exact: true }),
    ).toBeFocused();
    const inRow = await telegram.evaluate((el) => {
      const row = el.parentElement.getBoundingClientRect();
      const chip = el.getBoundingClientRect();
      return chip.left >= row.left && chip.right <= row.right;
    });
    expect(inRow).toBe(true);
  });

  test("the save bar appears after an edit and saves the profile", async ({ page }) => {
    const state = await setupAssistantSettings(page, { applyUpdates: true });
    await page.goto(baseURL + "/agents/home/settings");
    await expect(page.locator("#agent-profile")).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
    await page.getByRole("textbox", { name: "Name" }).fill("Home 2");
    await expect(bar(page)).toBeVisible();
    await expect(bar(page)).toContainText("Applies before the next message.");
    await bar(page).getByRole("button", { name: "Save agent" }).click();
    await expect.poll(() => state.updates.at(-1)?.name).toBe("Home 2");
    await expect(bar(page)).toHaveCount(0);
  });

  test("a failed save shows its error in the save bar", async ({ page }) => {
    await setupAssistantSettings(page, { saveStatus: 409 });
    await page.goto(baseURL + "/agents/home/settings");
    await page.getByRole("textbox", { name: "Name" }).fill("Home 2");
    await scroller(page).evaluate((el) => (el.scrollTop = el.scrollHeight));
    await bar(page).getByRole("button", { name: "Save agent" }).click();
    const alert = bar(page).getByRole("alert");
    await expect(alert).toContainText("Revision conflict");
    await expect(alert).toBeInViewport();
    await expect(bar(page).getByRole("button", { name: "Save agent" })).toBeEnabled();
  });

  test("the save bar mirrors a running save", async ({ page }) => {
    await setupAssistantSettings(page, { applyUpdates: true, saveDelay: 800 });
    await page.goto(baseURL + "/agents/home/settings");
    await page.getByRole("textbox", { name: "Name" }).fill("Home 2");
    await bar(page).getByRole("button", { name: "Save agent" }).click();
    await expect(bar(page).getByRole("button", { name: "Loading…" })).toBeDisabled();
    await expect(bar(page)).toHaveCount(0);
  });

  test("cancel in the save bar returns to the conversation", async ({ page }) => {
    const state = await setupAssistantSettings(page);
    await page.goto(baseURL + "/agents/home/settings");
    await page.getByRole("textbox", { name: "Name" }).fill("Home 2");
    await bar(page).getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(/\/agents\/home\/chats\/c1$/);
    expect(state.opened).toBe(1);
  });

  test("the save bar never covers the last section", async ({ page }) => {
    await setupAssistantSettings(page, { assistant: full });
    await page.goto(baseURL + "/agents/home/settings");
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Home 2");
    await expect(bar(page)).toBeVisible();
    // Stuck to the bottom edge while the form is still long.
    expect(
      await page.evaluate(
        () =>
          Math.round(
            document.querySelector(".assistant-save-bar").getBoundingClientRect().bottom,
          ) ===
          Math.round(
            document.querySelector(".assistant-settings-scroll").getBoundingClientRect()
              .bottom,
          ),
      ),
    ).toBe(true);
    await scroller(page).evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(page.locator("#agent-telegram button").last()).toBeVisible();
    const overlap = await page.evaluate(() => {
      const buttons = document.querySelectorAll("#agent-telegram button");
      const b = buttons[buttons.length - 1].getBoundingClientRect();
      const s = document.querySelector(".assistant-save-bar").getBoundingClientRect();
      return b.bottom > s.top && b.top < s.bottom;
    });
    expect(overlap).toBe(false);
  });

  test("the save bar fits a 320px phone", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await setupAssistantSettings(page);
    await page.goto(baseURL + "/agents/home/settings");
    await page.getByRole("textbox", { name: "Name" }).fill("Home 2");
    await expect(bar(page)).toBeVisible();
    const fit = await bar(page).evaluate((el) => {
      const row = el.getBoundingClientRect();
      return {
        noOverflow: el.scrollWidth <= el.clientWidth,
        inside: [...el.children].every((c) => {
          const r = c.getBoundingClientRect();
          return r.left >= row.left && r.right <= row.right;
        }),
      };
    });
    expect(fit).toEqual({ noOverflow: true, inside: true });
  });

  test("creating an agent shows the save bar at once", async ({ page }) => {
    await setupAssistantSettings(page);
    await page.goto(baseURL + "/agents");
    await page.getByRole("button", { name: "New agent" }).click();
    await expect(bar(page)).toBeVisible();
    await expect(bar(page).getByRole("button", { name: "Save agent" })).toBeVisible();
  });
});

test("desktop settings keep the in-form buttons and no save bar", async ({ page }) => {
  await setupAssistantSettings(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseURL + "/agents/home/settings");
  await page.getByRole("textbox", { name: "Name" }).fill("Home 2");
  await expect(page.locator(".assistant-save-bar")).toBeHidden();
  await expect(
    page.locator("#agent-profile").getByRole("button", { name: "Save agent" }),
  ).toBeVisible();
});
