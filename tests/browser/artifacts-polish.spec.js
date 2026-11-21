// AGENTPIER-456: Copy link uses the remote address like the publish result, and the
// usage line goes once no artifact is left; desktop and phone.
import { test, expect } from "../helpers/browser-test.js";
import { baseURL as base } from "../helpers/browser.js";
import { artifactsFixture, now, sessions } from "./artifacts-fixture.js";

const remoteUrl = "https://pier.example.ts.net";

for (const [label, viewport] of [
  ["desktop", { width: 1440, height: 1000 }],
  ["phone", { width: 390, height: 844 }],
]) {
  test(`Copy link copies the remote address (${label})`, async ({ page, context }) => {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text) => void (window.copiedText = text) },
      });
    });
    await page.clock.setFixedTime(now);
    await artifactsFixture(context, { language: "en" });
    await page.route("**/api/state", (route) =>
      route.fulfill({
        json: {
          tools: [{ id: "claude", name: "Claude Code", installed: true }],
          accounts: [],
          home: "/fixture",
          sessions,
          remoteUrl,
        },
      }),
    );
    await page.setViewportSize(viewport);
    await page.goto(`${base}/artifacts?artifact=a3`);
    const detail = page.locator(".artifact-detail");
    await detail.getByRole("button", { name: "Copy link" }).click();
    await expect
      .poll(() => page.evaluate(() => window.copiedText))
      .toBe(`${remoteUrl}/artifacts/view/a3`);
  });

  test(`the usage line goes with the last artifact (${label})`, async ({
    page,
    context,
  }) => {
    await page.clock.setFixedTime(now);
    await artifactsFixture(context, { language: "en", items: [] });
    let artifacts = 1;
    await page.route("**/api/artifacts/usage", (route) =>
      route.fulfill({
        json: {
          usedBytes: 4096,
          pendingCleanupBytes: 0,
          limitBytes: 1024 ** 3,
          artifacts,
        },
      }),
    );
    await page.setViewportSize(viewport);
    await page.goto(`${base}/artifacts`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Artifacts" }),
    ).toBeVisible();
    await expect(
      page
        .getByText(/ of 1 GB used/)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    artifacts = 0;
    await page.reload();
    await expect(
      page.getByRole("heading", { level: 1, name: "Artifacts" }),
    ).toBeVisible();
    await expect(page.getByText(/ of 1 GB used/)).toHaveCount(0);
  });
}
