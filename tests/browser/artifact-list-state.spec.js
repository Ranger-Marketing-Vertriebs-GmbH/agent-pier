import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
import { artifactsFixture, now } from "./artifacts-fixture.js";

test.use({ timezoneId: "Europe/Berlin" });

async function start(page, context) {
  await page.clock.setFixedTime(now);
  return artifactsFixture(context, { language: "en" });
}

const search = (page) => page.getByRole("searchbox", { name: "Search artifacts" });
const rows = (page) => page.locator(".artifacts-list .list-row");

test("the viewer returns to the Artifacts page with its way back to the session", async ({
  page,
  context,
}) => {
  await start(page, context);
  const origin = encodeURIComponent("/sessions/s1/chat");
  await page.goto(`${base}/artifacts?session=s1&artifact=a1&returnTo=${origin}`);
  const back = page.getByRole("button", { name: "Back to Settings redesign QA" });
  await expect(back).toBeVisible();
  // Open starts the viewer in a new tab; follow its address here.
  const open = page.getByRole("link", { name: "Open Settings QA report" });
  await expect(open).toHaveAttribute("target", "_blank");
  await page.goto(new URL(await open.getAttribute("href"), base).href);
  await expect(page.frameLocator("iframe").locator("h1")).toHaveText("Private report");
  await page.getByRole("link", { name: "Back to AgentPier" }).click();
  await expect(page).toHaveURL(/\/artifacts\?session=s1&artifact=a1&returnTo=/);
  await back.click();
  await expect(page).toHaveURL(/\/sessions\/s1\/chat$/);
});

test("a pasted tab in the search becomes a space instead of a rejected request", async ({
  page,
  context,
}) => {
  const state = await start(page, context);
  await page.goto(`${base}/artifacts`);
  await expect(rows(page).first()).toBeVisible();
  await search(page).fill("Settings\tQA");
  await expect(page).toHaveURL(/q=Settings\+QA/);
  await expect(rows(page)).toHaveText([/Settings QA report/]);
  await expect(page.locator(".artifacts-list .loading")).toHaveCount(0);
  expect(state.requests.every((query) => !/%09|\t/.test(query))).toBe(true);
});

test("a rejected search shows its error instead of loading forever", async ({
  page,
  context,
}) => {
  await start(page, context);
  await context.route(/\/api\/artifacts\?.*q=/, (route) =>
    route.fulfill({
      status: 429,
      json: { error: "Too many", code: "ARTIFACT_RATE_LIMITED" },
    }),
  );
  await page.goto(`${base}/artifacts`);
  await expect(rows(page).first()).toBeVisible();
  await search(page).fill("report");
  await expect(
    page.getByRole("alert").filter({ hasText: "Too many searches." }),
  ).toBeVisible();
  await expect(page.locator(".artifacts-list .loading")).toHaveCount(0);
});

test("an unknown project in the address drops out of the filter", async ({
  page,
  context,
}) => {
  await start(page, context);
  await page.goto(`${base}/artifacts/deleted-project?tab=pinned`);
  await expect(page).toHaveURL(`${base}/artifacts?tab=pinned`);
  await expect(page.getByRole("combobox", { name: "Project" })).toHaveValue("");
  await expect(rows(page)).toHaveCount(2);
});

test("the no longer available notice ends with the list it was shown on", async ({
  page,
  context,
}) => {
  await start(page, context);
  const notice = page.locator(".artifacts-notice");
  for (const change of [
    () => page.getByRole("tab", { name: /^Pinned/ }).click(),
    () => page.getByRole("combobox", { name: "Project" }).selectOption("p1"),
    () => search(page).fill("release"),
    () =>
      page
        .getByRole("button", {
          name: "Remove the filter for session Settings redesign QA",
        })
        .click(),
  ]) {
    await page.goto(`${base}/artifacts?session=s1&artifact=missing1`);
    await expect(notice).toHaveText("This artifact is no longer available.");
    await change();
    await expect(notice).toHaveCount(0);
  }
  // Back on the original list, the notice does not return either.
  await page.goto(`${base}/artifacts?artifact=missing1`);
  await expect(notice).toBeVisible();
  await page.getByRole("tab", { name: /^Pinned/ }).click();
  await page.getByRole("tab", { name: /^All/ }).click();
  await expect(rows(page).first()).toBeVisible();
  await expect(notice).toHaveCount(0);
});

test("the viewer retries a busy bundle like the preview does", async ({
  page,
  context,
}) => {
  await start(page, context);
  let calls = 0;
  await context.route("**/api/artifacts/a1/bundle", (route) => {
    calls++;
    if (calls === 1)
      return route.fulfill({
        status: 503,
        json: { code: "ARTIFACT_BUSY", error: "Another artifact is loading." },
      });
    return route.fallback();
  });
  await page.goto(`${base}/artifacts/view/a1`);
  await expect(page.frameLocator("iframe").locator("h1")).toHaveText("Private report");
  expect(calls).toBe(2);
});
