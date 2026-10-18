import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
import { artifactsFixture, now } from "./artifacts-fixture.js";

test.use({ timezoneId: "Europe/Berlin" });

async function start(page, context) {
  await page.clock.setFixedTime(now);
  return artifactsFixture(context, { language: "en" });
}

test("Download saves the artifact under its server file name without leaving the page", async ({
  page,
  context,
  browserName,
}) => {
  await start(page, context);
  // The name the page hands the browser, before the engine sanitizes it.
  await page.addInitScript(() => {
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) (window.__downloadNames ||= []).push(this.download);
      return click.call(this);
    };
  });
  const requests = [];
  await context.route(/\/api\/artifacts\/a1\/download$/, (route) => {
    requests.push(route.request().url());
    return route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="Settings QA report.zip"; filename*=UTF-8''Settings%20QA%20report.zip`,
      },
      body: Buffer.from("PK\x05\x06" + "\0".repeat(18), "binary"),
    });
  });
  await page.goto(`${base}/artifacts?artifact=a1`);
  const address = page.url();
  const button = page.getByRole("button", { name: "Download Settings QA report" });
  await expect(button).toHaveText("Download");
  const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
  expect(await page.evaluate(() => window.__downloadNames)).toEqual([
    "Settings QA report.zip",
  ]);
  // WebKit on Linux (WebKitGTK) reports spaces as underscores; Safari keeps them.
  const saved = "Settings QA report.zip";
  expect(download.suggestedFilename()).toBe(
    browserName === "webkit" && process.platform === "linux"
      ? saved.replaceAll(" ", "_")
      : saved,
  );
  expect(download.url()).toMatch(/^blob:/);
  expect(requests).toHaveLength(1);
  expect(page.url()).toBe(address);
  await expect(button).toBeEnabled();
});

test("a refused download explains why and keeps the detail open", async ({
  page,
  context,
}) => {
  await start(page, context);
  await context.route(/\/api\/artifacts\/a1\/download$/, (route) =>
    route.fulfill({
      status: 429,
      json: { error: "Too many", code: "ARTIFACT_DOWNLOAD_RATE_LIMITED" },
    }),
  );
  await page.goto(`${base}/artifacts?artifact=a1`);
  await page.getByRole("button", { name: "Download Settings QA report" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Too many downloads. Try again in a minute." }),
  ).toBeVisible();
  await expect(page).toHaveURL(/artifact=a1/);
});
