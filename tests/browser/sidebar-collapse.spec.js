import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

test("the sidebar collapses on wide screens and expands again from the floating control", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto(baseURL);
  const sidebar = page.locator(".sidebar");
  const main = page.locator("main");
  await expect(sidebar).toBeVisible();
  await expect(main).toHaveCSS("margin-left", "252px");
  await page.getByRole("button", { name: "Navigation einklappen" }).click();
  // Hiding the sidebar outright also keeps its navigation out of the tab order.
  await expect(sidebar).toBeHidden();
  await expect(main).toHaveCSS("margin-left", "0px");
  await page.getByRole("button", { name: "Navigation ausklappen" }).click();
  await expect(sidebar).toBeVisible();
  await expect(main).toHaveCSS("margin-left", "252px");
});

test("a collapsed sidebar does not break the mobile drawer", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto(baseURL);
  await page.getByRole("button", { name: "Navigation einklappen" }).click();
  const drawer = page.locator(".sidebar");
  await expect(drawer).toBeHidden();
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(page.getByRole("button", { name: "Navigation ausklappen" })).toBeHidden();
  const left = async () => (await drawer.boundingBox()).x;
  // A visible drawer can still sit outside the viewport, so the position decides.
  expect(await left()).toBeLessThan(0);
  await page.getByRole("button", { name: "Navigation öffnen" }).click();
  await expect(drawer).toHaveClass(/open/);
  await expect.poll(left).toBe(0);
  await drawer.getByRole("button", { name: "Übersicht" }).click();
  await expect(drawer).not.toHaveClass(/open/);
  await expect.poll(left).toBeLessThan(0);
  // The collapsed desktop layout survives the detour through the drawer.
  await page.setViewportSize({ width: 1500, height: 1000 });
  await expect(drawer).toBeHidden();
  await expect(page.getByRole("button", { name: "Navigation ausklappen" })).toBeVisible();
});

test("collapsing inside a session does not push the viewport-sized workspace out of view", async ({
  page,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        tools: [],
        accounts: [],
        home: "/fixture",
        sessions: [
          {
            id: "collapse",
            name: "Collapse",
            tool: "codex",
            cwd: "/fixture",
            status: "running",
          },
        ],
        messages: [],
        tasks: [],
        availability: "ready",
      },
    }),
  );
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto(baseURL + "/sessions/collapse/chat");
  const workspace = page.locator(".session-workspace");
  await expect(workspace).toBeVisible();
  await page.getByRole("button", { name: "Navigation einklappen" }).click();
  await expect(page.locator(".sidebar")).toBeHidden();
  const geometry = await page.evaluate(() => {
    const centre = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return Math.round(rect.y + rect.height / 2);
    };
    return {
      overflow: document.documentElement.scrollHeight - window.innerHeight,
      toggle: centre(".sidebar-float"),
      mark: centre(".session-title .provider-mark"),
      actions: centre(".session-actions"),
    };
  });
  expect(geometry.overflow).toBeLessThanOrEqual(0);
  // The floating toggle reads as part of the session heading row.
  expect(geometry.mark).toBe(geometry.toggle);
  expect(geometry.actions).toBe(geometry.toggle);
});

const fixture = {
  json: {
    tools: [{ id: "codex", name: "Codex", installed: true }],
    accounts: [],
    home: "/fixture",
    sessions: [],
    messages: [],
    tasks: [],
    availability: "ready",
  },
};
const translations = {
  de: {
    locale: "de-DE",
    collapse: "Navigation einklappen",
    expand: "Navigation ausklappen",
    newSession: "Neue Sitzung",
  },
  en: {
    locale: "en-US",
    collapse: "Collapse navigation",
    expand: "Expand navigation",
    newSession: "New session",
  },
};
for (const [language, copy] of Object.entries(translations)) {
  test.describe(`keyboard operation in ${language}`, () => {
    test.use({ locale: copy.locale });
    test("collapsing and restoring by keyboard moves the focus to the replacement toggle", async ({
      page,
      browserName,
    }) => {
      await page.addInitScript(
        (value) => localStorage.setItem("agentpier-language", value),
        language,
      );
      await page.route("**/api/**", (route) => route.fulfill(fixture));
      await page.setViewportSize({ width: 1500, height: 1000 });
      await page.goto(baseURL);
      await page.getByRole("button", { name: copy.collapse }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: copy.expand })).toBeFocused();
      // The floating controls stay reachable in the tab order behind the toggle.
      // WebKit follows Safari, where Alt+Tab walks the buttons.
      await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
      await expect(
        page.locator(".sidebar-float").getByRole("button", { name: copy.newSession }),
      ).toBeFocused();
      await page.getByRole("button", { name: copy.expand }).focus();
      await page.keyboard.press("Space");
      await expect(page.getByRole("button", { name: copy.collapse })).toBeFocused();
    });
  });
}
