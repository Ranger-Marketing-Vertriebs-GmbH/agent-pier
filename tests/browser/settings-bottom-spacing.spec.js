import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import {
  connectedChannel,
  setupAssistantSettings,
} from "../helpers/assistant-settings-browser.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";
import { settingsBar } from "../helpers/settings.js";
import { operationsFixture } from "./operations-fixture.js";

// The iPhone home indicator: browsers outside iOS report env(safe-area-inset-bottom)
// as 0, so the pages read it through --safe-area-inset-bottom, set here instead.
const SAFE_AREA = 34;
const MIN_GAP = 12;
const full = { capabilities: { memory: true, reminders: true } };

async function emulateSafeArea(page) {
  await page.evaluate(
    (px) =>
      document.documentElement.style.setProperty("--safe-area-inset-bottom", `${px}px`),
    SAFE_AREA,
  );
}

/**
 * Scrolls the content's scroller to its end and returns where the last content ends,
 * where the visible area ends (scroller bottom minus the home indicator) and the save
 * bar's box, if any.
 */
function scrollToEnd(page, content) {
  return page.locator(content).evaluate((root) => {
    const scrolls = (el) =>
      /(auto|scroll)/.test(getComputedStyle(el).overflowY) &&
      el.scrollHeight > el.clientHeight;
    let scroller = root.parentElement;
    while (scroller && scroller !== document.body && !scrolls(scroller))
      scroller = scroller.parentElement;
    if (!scroller || scroller === document.body) scroller = document.scrollingElement;
    scroller.scrollTop = scroller.scrollHeight;
    const document_ = scroller === document.scrollingElement;
    const bottom = document_
      ? window.innerHeight
      : Math.min(scroller.getBoundingClientRect().bottom, window.innerHeight);
    const safe = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--safe-area-inset-bottom",
      ),
    );
    const bar = document.querySelector(".save-bar");
    let contentBottom = 0;
    for (const el of root.querySelectorAll("*")) {
      if (bar?.contains(el)) continue;
      const box = el.getBoundingClientRect();
      if (box.width && box.height) contentBottom = Math.max(contentBottom, box.bottom);
    }
    const barBox = bar?.getBoundingClientRect();
    return {
      atEnd: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1,
      contentBottom,
      visibleBottom: bottom - safe,
      bar: barBox && {
        top: barBox.top,
        bottom: barBox.bottom,
        paddingBottom: parseFloat(getComputedStyle(bar).paddingBottom),
      },
    };
  });
}

async function expectEndClear(page, content, withBar) {
  await expect
    .poll(async () => {
      const end = await scrollToEnd(page, content);
      const limit = withBar ? end.bar?.top : end.visibleBottom;
      return {
        atEnd: end.atEnd,
        bar: Boolean(end.bar),
        lastCardClear: limit - end.contentBottom >= MIN_GAP,
        barAboveEdge: !withBar || end.bar.bottom <= end.visibleBottom + SAFE_AREA + 0.5,
        barClearsHomeIndicator: !withBar || end.bar.paddingBottom >= SAFE_AREA,
      };
    })
    .toEqual({
      atEnd: true,
      bar: withBar,
      lastCardClear: true,
      barAboveEdge: true,
      barClearsHomeIndicator: true,
    });
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 375, height: 667 },
]) {
  test.describe(`settings end spacing at ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true, locale: "en-GB" });

    for (const tab of ["profile", "capabilities", "work", "telegram"]) {
      test(`agent ${tab} tab ends clear of the home indicator`, async ({ page }) => {
        await setupAssistantSettings(page, {
          assistant: full,
          channel: connectedChannel(),
        });
        await page.goto(baseURL + settingsPath(tab));
        await expect(page.locator(".agent-settings-main")).toBeVisible();
        await expect(page.locator(".agent-settings-main > *").first()).toBeVisible();
        await emulateSafeArea(page);
        await expectEndClear(page, ".agent-settings-main", false);
      });
    }

    test("agent profile tab ends clear of the save bar", async ({ page }) => {
      await setupAssistantSettings(page, {
        assistant: full,
        channel: connectedChannel(),
      });
      await page.goto(baseURL + settingsPath("profile"));
      await page.getByLabel("Name", { exact: true }).fill("Home renamed");
      await expect(saveBar(page)).toBeVisible();
      await emulateSafeArea(page);
      await expectEndClear(page, ".agent-settings-main", true);
    });

    test("general settings end clear of the home indicator and save bar", async ({
      page,
    }) => {
      await operationsFixture(page);
      await page.goto(baseURL + "/settings");
      const toggle = page.getByRole("switch", {
        name: "Resume interrupted sessions automatically",
      });
      await expect(toggle).toBeVisible();
      await emulateSafeArea(page);
      await expectEndClear(page, ".settings-shell-content", false);
      await toggle.click();
      await expect(settingsBar(page)).toBeVisible();
      await expectEndClear(page, ".settings-shell-content", true);
    });
  });
}
