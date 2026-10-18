import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { phone } from "./touch-input-size.js";
import { fixture } from "./providers-fixture.js";

// docs/ui-guide.md#mobile-and-touch: on a phone every button, compact button and icon
// button is at least 44px tall (icon buttons also 44px wide), and checkbox labels
// offer the same target.
test.use(phone);

const pages = [
  ["workspace", "/"],
  ["agents", "/agents"],
  ["accounts", "/accounts"],
  ["accounts mcp", "/accounts?section=mcp-servers"],
  ["projects", "/repositories"],
  ["files", "/files"],
  ["artifacts", "/artifacts"],
  ["memory", "/memory"],
  ["extensions", "/extensions"],
  ["pipelines runs", "/pipelines"],
  ["pipelines definitions", "/pipelines/definitions"],
  ["settings", "/settings"],
  ["settings notifications", "/settings/notifications"],
  ["settings diagnostics", "/settings/diagnostics"],
  ["settings backups", "/settings/backups"],
  ["settings mcp", "/settings/mcp"],
  ["settings remote", "/settings/remote"],
  ["settings ssh", "/settings/ssh"],
  ["settings components", "/settings/components"],
];

async function smallTargets(page) {
  return page.evaluate(() => {
    const target = 44 - 0.5;
    const found = [];
    const describe = (element) =>
      `${element.tagName.toLowerCase()}${[...element.classList].map((name) => `.${name}`).join("")} "${(element.getAttribute("aria-label") || element.innerText || "").trim().slice(0, 30)}"`;
    for (const element of document.querySelectorAll(
      ".button, .compact, .icon-button, label:has(> input[type='checkbox'])",
    )) {
      if (!element.checkVisibility({ checkVisibilityCSS: true })) continue;
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const icon = element.classList.contains("icon-button");
      if (box.height < target || (icon && box.width < target))
        found.push(
          `${describe(element)} ${Math.round(box.width)}×${Math.round(box.height)}`,
        );
    }
    return found;
  });
}

for (const [view, path] of pages)
  test(`${view} keeps buttons at 44px on a phone`, async ({ page }) => {
    await page.goto(baseURL + path);
    await page.locator("#root *").first().waitFor();
    await page.waitForTimeout(1200);
    const small = await smallTargets(page);
    expect(small, `${view}: targets under 44px`).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, `${view} scrolls sideways`).toBeLessThanOrEqual(0);
  });

test("the session header actions are 44px touch targets", async ({ page }) => {
  await fixture(page, {
    session: {
      id: "touch-session",
      name: "Touch session",
      tool: "claude",
      accountId: "internal-isolated-profile",
      cwd: "/fixture",
      status: "running",
    },
  });
  await page.goto(baseURL + "/sessions/touch-session/terminal");
  await expect(page.locator(".session-actions > .icon-button").first()).toBeVisible();
  expect(await smallTargets(page)).toEqual([]);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1440, height: 1000 }, hasTouch: false, isMobile: false });

  test("compact and icon buttons keep their 33px desktop size", async ({ page }) => {
    await page.goto(baseURL + "/settings/components");
    const icon = page.locator(".gallery-demo .icon-button").first();
    await expect(icon).toHaveCSS("height", "33px");
    await expect(page.locator(".gallery-demo .button.compact").first()).toHaveCSS(
      "height",
      "33px",
    );
  });
});
