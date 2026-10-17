import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright";
import {
  inputCalls,
  validateInput,
} from "../../server/features/assistants/browser-input.js";

// The owner's keys as CDP events in a real Chromium; skipped where Playwright's
// Chromium is not installed.
const executable = (() => {
  try {
    return chromium.executablePath();
  } catch {
    return "";
  }
})();
const options = {
  skip: !fs.existsSync(executable) && "Playwright Chromium is not installed",
  timeout: 60000,
};

test("Enter submits a form and breaks a line; typed keys arrive", options, async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    `<form onsubmit="event.preventDefault();window.sent=(window.sent||0)+1"><input id=i></form><textarea id=t></textarea>`,
  );
  const cdp = await page.context().newCDPSession(page);
  const send = async (command) => {
    for (const [method, params] of inputCalls(validateInput(command), null))
      await cdp.send(method, params);
  };
  const press = async (key, code = key) => {
    await send({ type: "key", action: "down", key, code });
    await send({ type: "key", action: "up", key, code });
  };
  await page.focus("#i");
  await press("a", "KeyA");
  await press("Enter");
  assert.equal(await page.evaluate(() => window.sent || 0), 1);
  assert.equal(await page.$eval("#i", (element) => element.value), "a");
  await page.focus("#t");
  await send({ type: "text", text: "Zeile" });
  await press("Enter");
  await press("Backspace");
  await press("Enter");
  await send({ type: "text", text: "zwei" });
  assert.equal(await page.$eval("#t", (element) => element.value), "Zeile\nzwei");
});
