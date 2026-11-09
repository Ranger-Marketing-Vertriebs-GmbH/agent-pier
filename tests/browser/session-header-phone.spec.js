import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./providers-fixture.js";
import { selectEnglish } from "../helpers/file-explorer-browser.js";

const session = {
  id: "s1",
  name: "Claude davidka",
  tool: "claude",
  accountId: "local-claude",
  cwd: "/fixture",
  status: "running",
  agentpierTools: true,
};

async function contained(page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const heading = document.querySelector(".session-heading");
    const parts = [...heading.querySelectorAll("button, summary, h1")]
      .map((element) => element.getBoundingClientRect())
      .filter((box) => box.width > 0);
    const title = document.querySelector(".session-title h1").getBoundingClientRect();
    const actions = document.querySelector(".session-actions").getBoundingClientRect();
    const overlap =
      title.right > actions.left + 1 &&
      title.left < actions.right &&
      title.bottom > actions.top + 1 &&
      title.top < actions.bottom;
    return {
      page: document.documentElement.scrollWidth - width,
      heading: heading.scrollWidth - heading.clientWidth,
      outside: parts.filter((box) => box.left < 0 || box.right > width + 0.5).length,
      overlap,
    };
  });
}

for (const mode of ["chat", "terminal"]) {
  test(`phone ${mode}: the session header fits and every action is in the More menu`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await fixture(page, { session });
    await selectEnglish(page);
    await page.goto(`${baseURL}/sessions/s1/${mode}`);
    await expect(page.locator(".session-title h1")).toHaveText("Claude davidka");
    const more = page.locator(".session-heading").getByRole("button", {
      name: "More actions",
      exact: true,
    });
    await expect(more).toBeVisible();
    expect(await contained(page)).toEqual({
      page: 0,
      heading: 0,
      outside: 0,
      overlap: false,
    });
    await more.click();
    const menu = page.getByRole("menu", { name: "More actions", exact: true });
    for (const name of [/Reload/, /tools/i, /Rename/, /Stop/])
      await expect(menu.getByRole("menuitem", { name })).toBeVisible();
    await page.keyboard.press("Escape");
  });
}

test("desktop keeps the session actions as header icons", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await fixture(page, { session });
  await selectEnglish(page);
  await page.goto(`${baseURL}/sessions/s1/terminal`);
  const heading = page.locator(".session-heading");
  await expect(heading.getByRole("button", { name: "Rename session" })).toBeVisible();
  await expect(heading.getByRole("button", { name: "More actions" })).toHaveCount(0);
  expect((await contained(page)).page).toBe(0);
});
