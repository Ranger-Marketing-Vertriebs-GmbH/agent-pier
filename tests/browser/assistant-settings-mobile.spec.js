import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import {
  connectedChannel,
  setupAssistantSettings,
} from "../helpers/assistant-settings-browser.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";

const full = { capabilities: { memory: true, reminders: true } };
const bar = (page) => saveBar(page);
const scroller = (page) => page.locator(".assistant-settings-scroll");

test.describe("agent settings on phones", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("header and tabs stay put while the settings body scrolls", async ({ page }) => {
    await setupAssistantSettings(page, { assistant: full, channel: connectedChannel() });
    await page.setViewportSize({ width: 390, height: 600 });
    await page.goto(baseURL + settingsPath("telegram"));
    const nav = page.getByRole("tablist", { name: "Agent settings" });
    await expect(nav).toBeVisible();
    await expect(page.locator(".mobile-header")).toBeHidden();
    const before = await page.evaluate(() => ({
      header: document
        .querySelector(".assistant-settings-page > header")
        .getBoundingClientRect().top,
      nav: document.querySelector(".agent-settings-tabs").getBoundingClientRect().top,
    }));
    await scroller(page).evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect
      .poll(() =>
        page.evaluate(() => ({
          header: document
            .querySelector(".assistant-settings-page > header")
            .getBoundingClientRect().top,
          nav: document.querySelector(".agent-settings-tabs").getBoundingClientRect().top,
          documentScroll: window.scrollY,
          bodyScrolled:
            document.querySelector(".assistant-settings-scroll").scrollTop > 0,
        })),
      )
      .toEqual({ ...before, documentScroll: 0, bodyScrolled: true });
  });

  test("profile fields keep 16px text and selects as tall as inputs", async ({
    page,
  }) => {
    await setupAssistantSettings(page);
    await page.goto(baseURL + settingsPath("identity"));
    const style = await page.locator("#agent-profile").evaluate((el) => {
      const textBox = (field) => {
        const c = getComputedStyle(field);
        return (
          field.clientHeight - parseFloat(c.paddingTop) - parseFloat(c.paddingBottom)
        );
      };
      const field = el.querySelector("input");
      const select = el.querySelector("select");
      return {
        selectHeight: select.offsetHeight === field.offsetHeight,
        selectUnclipped: textBox(select) >= textBox(field),
        inputSize: getComputedStyle(field).fontSize,
        selectSize: getComputedStyle(select).fontSize,
      };
    });
    expect(style).toEqual({
      selectHeight: true,
      selectUnclipped: true,
      inputSize: "16px",
      selectSize: "16px",
    });
  });

  test("selects show the 16px handoff chevron 12px from the edge", async ({ page }) => {
    await setupAssistantSettings(page);
    await page.goto(baseURL + settingsPath("identity"));
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

  test("the agent service sits inside Overview on phones", async ({ page }) => {
    await setupAssistantSettings(page);
    await page.goto(baseURL + settingsPath());
    await expect(page.locator(".agent-runtime-group")).toBeVisible();
    await expect(page.locator(".agent-runtime-aside")).toBeHidden();
  });

  test("switches keep their native semantics", async ({ page }) => {
    await setupAssistantSettings(page);
    await page.goto(baseURL + settingsPath("capabilities"));
    const memory = page.getByRole("switch", { name: "Remember information" });
    await expect(memory).not.toBeChecked();
    const box = await memory.boundingBox();
    expect([Math.round(box.width), Math.round(box.height)]).toEqual([38, 22]);
    await memory.check();
    await expect(memory).toBeChecked();
  });

  for (const width of [390, 320])
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 640 });
      await setupAssistantSettings(page, {
        assistant: full,
        channel: connectedChannel(),
      });
      for (const tab of [
        undefined,
        "identity",
        "capabilities",
        "access",
        "team",
        "automation",
        "channels",
      ]) {
        await page.goto(baseURL + settingsPath(tab));
        await expect(page.getByRole("tabpanel")).toBeVisible();
        expect(
          await page.evaluate(() => {
            const el = document.querySelector(".assistant-settings-scroll");
            return (
              document.documentElement.scrollWidth <= innerWidth &&
              el.scrollWidth <= el.clientWidth
            );
          }),
          tab ?? "overview",
        ).toBe(true);
      }
    });

  test("the save bar appears after an edit and saves the profile", async ({ page }) => {
    const state = await setupAssistantSettings(page, { applyUpdates: true });
    await page.goto(baseURL + settingsPath("identity"));
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
    await page.goto(baseURL + settingsPath("identity"));
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
    await page.goto(baseURL + settingsPath("identity"));
    await page.getByRole("textbox", { name: "Name" }).fill("Home 2");
    await bar(page).getByRole("button", { name: "Save agent" }).click();
    await expect(bar(page).getByRole("button", { name: "Saving …" })).toBeDisabled();
    await expect(bar(page)).toHaveCount(0);
  });

  test("cancel in the save bar restores the saved values", async ({ page }) => {
    const state = await setupAssistantSettings(page);
    await page.goto(baseURL + settingsPath("identity"));
    const name = page.getByRole("textbox", { name: "Name" });
    await name.fill("Home 2");
    await bar(page).getByRole("button", { name: "Cancel" }).click();
    await expect(name).toHaveValue("Home");
    await expect(bar(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/agents\/home\/settings\?tab=identity$/);
    expect(state.opened).toBe(0);
  });

  test("the save bar never covers the last section", async ({ page }) => {
    await setupAssistantSettings(page, { assistant: full, channel: connectedChannel() });
    await page.setViewportSize({ width: 390, height: 600 });
    await page.goto(baseURL + settingsPath("telegram"));
    await page.getByLabel("AgentPier address for links").fill("https://pier.example");
    await expect(bar(page)).toBeVisible();
    // Stuck to the bottom edge while the tab is still longer than the scroller.
    expect(
      await page.evaluate(
        () =>
          Math.round(
            document.querySelector(".save-bar").getBoundingClientRect().bottom,
          ) ===
          Math.round(
            document.querySelector(".assistant-settings-scroll").getBoundingClientRect()
              .bottom,
          ),
      ),
    ).toBe(true);
    await scroller(page).evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(
      page.locator("#agent-telegram button:not(.save-bar button)").last(),
    ).toBeVisible();
    const overlap = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll("#agent-telegram button")].filter(
        (b) => !b.closest(".save-bar"),
      );
      const b = buttons[buttons.length - 1].getBoundingClientRect();
      const s = document.querySelector(".save-bar").getBoundingClientRect();
      return b.bottom > s.top && b.top < s.bottom;
    });
    expect(overlap).toBe(false);
  });

  test("the save bar fits a 320px phone", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await setupAssistantSettings(page);
    await page.goto(baseURL + settingsPath("identity"));
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

  test("the new agent wizard keeps its buttons in the bar", async ({ page }) => {
    await setupAssistantSettings(page);
    await page.goto(baseURL + "/agents");
    await page.getByRole("main").getByRole("link", { name: "New agent" }).click();
    const steps = page.getByRole("region", { name: "Steps" });
    await expect(steps.getByRole("button", { name: "Next" })).toBeVisible();
    await expect(steps.getByRole("button", { name: "Back" })).toBeDisabled();
  });
});

test("desktop settings save from the same bar", async ({ page }) => {
  await setupAssistantSettings(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseURL + settingsPath("identity"));
  await page.getByRole("textbox", { name: "Name" }).fill("Home 2");
  await expect(saveBar(page).getByRole("button", { name: "Save agent" })).toBeVisible();
  await expect(
    page.locator("#agent-profile").getByRole("button", { name: "Save agent" }),
  ).toHaveCount(0);
});
