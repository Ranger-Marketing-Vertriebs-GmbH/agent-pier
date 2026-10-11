import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

test("bundled DM Sans and Manrope load from the app origin", async ({ page }) => {
  const requests = [];
  const consoleMessages = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("console", (message) => consoleMessages.push(message.text()));

  await page.goto(baseURL);
  await page.evaluate(() => document.fonts.load('500 13px "DM Sans"'));
  await page.evaluate(() => document.fonts.load('800 22px "Manrope"'));
  await page.evaluate(() => document.fonts.ready);

  const state = await page.evaluate(() => ({
    dmSans: document.fonts.check('500 13px "DM Sans"'),
    manrope: document.fonts.check('800 22px "Manrope"'),
    loadedDmSans: [...document.fonts].filter(
      (face) => face.family.replaceAll('"', "") === "DM Sans" && face.status === "loaded",
    ).length,
  }));

  expect(state.dmSans).toBe(true);
  expect(state.manrope).toBe(true);
  expect(state.loadedDmSans).toBeGreaterThan(0);
  expect(requests.filter((url) => /fonts\.(googleapis|gstatic)\.com/.test(url))).toEqual(
    [],
  );
  expect(consoleMessages.filter((text) => /font-src/i.test(text))).toEqual([]);
});
