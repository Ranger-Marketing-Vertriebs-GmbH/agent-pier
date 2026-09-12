import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

const remoteUrl = "https://agentpier.example.test:8443";

async function workspace(page, origin, configuredUrl = remoteUrl) {
  // Keep the real browser origin while serving assets from the disposable app.
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/auth/status")
      return route.fulfill({ json: { configured: true, authenticated: true } });
    if (url.pathname === "/api/state")
      return route.fulfill({
        json: {
          tools: [],
          accounts: [],
          sessions: [],
          home: "/fixture",
          remoteUrl: configuredUrl,
        },
      });
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
    const response = await route.fetch({
      url: `${baseURL}${url.pathname}${url.search}`,
      headers: { origin: baseURL, host: new URL(baseURL).host },
    });
    return route.fulfill({ response });
  });
  await page.goto(origin);
  await expect(page.locator(".host-status")).toContainText(
    /Auf deinem Rechner|On your computer/,
  );
}

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(locale, () => {
    test.use({ locale });
    const label = locale === "de-DE" ? "Remote öffnen" : "Open remotely";

    for (const origin of [
      remoteUrl,
      "http://192.168.1.10:4380",
      "https://other-host.example.test",
    ]) {
      test(`hides the remote shortcut when already accessed through ${origin}`, async ({
        page,
      }) => {
        await workspace(page, origin);
        await expect(page.getByRole("link", { name: label })).toHaveCount(0);
        if (origin === remoteUrl && locale === "en-GB")
          await page.screenshot({ path: test.info().outputPath("remote-sidebar.png") });
      });
    }

    for (const origin of [
      "http://localhost:4380",
      "http://127.0.0.1:4380",
      "http://[::1]:4380",
    ]) {
      test(`offers the configured remote URL from ${origin}`, async ({ page }) => {
        await workspace(page, origin);
        await expect(page.getByRole("link", { name: label })).toHaveAttribute(
          "href",
          remoteUrl,
        );
      });
    }

    test("does not offer remote access without a configured URL", async ({ page }) => {
      await workspace(page, "http://localhost:4380", null);
      await expect(page.getByRole("link", { name: label })).toHaveCount(0);
    });
  });
}
