import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";
import { openAccountItem } from "../helpers/accounts-browser.js";

const account = {
  id: "openclaw:expired",
  name: "someone.with.a.long.address@example.com",
  status: "expired",
  available: true,
};

async function setup(page) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const path = new URL(route.request().url()).pathname;
    let body;
    if (path === "/api/assistant-model-accounts") body = { accounts: [account] };
    else if (path === "/api/assistant-runtime") body = { availability: "ready" };
    else if (path === "/api/assistants")
      body = { assistants: [], conversations: [], models: [account] };
    else return route.fallback();
    await route.fulfill({ json: body });
  });
}

test("a long row value on a phone wraps beside a label that keeps its words", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL + "/accounts");
  const detail = await openAccountItem(page, account.name);
  const row = detail.locator(".list-row", { hasText: "ChatGPT for agents" });
  await expect(row.locator(".list-row-value")).toHaveText(
    "Expired · check connection to attempt renewal",
  );
  await page.screenshot({ path: ".cache/list-row-phone-en.png" });
  const label = await row.locator(".list-row-label").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const lines = new Set(
      [...range.getClientRects()].map((rect) => Math.round(rect.top)),
    );
    const probe = element.cloneNode(true);
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
    document.body.append(probe);
    const textWidth = probe.getBoundingClientRect().width;
    probe.remove();
    return { lines: lines.size, width: element.getBoundingClientRect().width, textWidth };
  });
  expect(label.lines).toBe(1);
  expect(label.width).toBeGreaterThanOrEqual(label.textWidth - 1);
  const [labelBox, valueBox, rowBox] = await Promise.all([
    row.locator(".list-row-label").boundingBox(),
    row.locator(".list-row-value").boundingBox(),
    row.boundingBox(),
  ]);
  expect(valueBox.x).toBeGreaterThanOrEqual(labelBox.x + labelBox.width);
  expect(valueBox.x + valueBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
