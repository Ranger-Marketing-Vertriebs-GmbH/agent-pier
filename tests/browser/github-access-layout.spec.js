import { test, expect } from "../helpers/browser-test.js";
import { fixture } from "../helpers/repository-browser.js";

const checkedAt = "2026-11-10T10:00:00Z";
// A classic token with every scope: the list that used to make each card very tall.
const scopes = [
  "admin:enterprise",
  "admin:gpg_key",
  "admin:org",
  "admin:org_hook",
  "admin:public_key",
  "admin:repo_hook",
  "admin:ssh_signing_key",
  "audit_log",
  "codespace",
  "copilot",
  "delete:packages",
  "delete_repo",
  "gist",
  "notifications",
  "project",
  "repo",
  "user",
  "workflow",
  "write:discussion",
  "write:packages",
];

for (const width of [1080, 1440, 390]) {
  test(`GitHub connections stay inside their cards at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
    const { repositories } = await fixture(page);
    repositories.credentials[0].tokenCheck = {
      state: "valid",
      login: "octo-owner",
      tokenType: "classic",
      scopes,
      expiresAt: null,
      checkedAt,
    };
    repositories.credentials.push({
      id: "work",
      name: "Work",
      host: "https://github.example.com:8443",
      hasSecret: true,
      agentDefault: false,
      createdAt: checkedAt,
      commitIdentity: { name: "Work Author", email: "work.author@example.test" },
    });
    await page.goto("/settings/github");
    const card = (name) =>
      page
        .getByRole("listitem")
        .filter({ has: page.getByRole("heading", { name, exact: true }) });
    await expect(card("Work")).toBeVisible();

    // Every action button lies inside its card, and nothing scrolls sideways.
    for (const name of ["Persönlich", "Work"]) {
      const box = await card(name).boundingBox();
      const buttons = card(name).locator(".github-access-actions > *");
      expect(await buttons.count()).toBeGreaterThanOrEqual(3);
      for (const button of await buttons.all()) {
        const inner = await button.boundingBox();
        expect(inner.x).toBeGreaterThanOrEqual(box.x);
        expect(inner.x + inner.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      }
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);

    // The commit identity shows when set and a placeholder when not.
    await expect(card("Work")).toContainText("Work Author <work.author@example.test>");
    await expect(card("Persönlich")).toContainText(
      "Not set · git keeps its own identity",
    );

    // The scope list is folded behind its count until opened.
    const summary = card("Persönlich").getByText("20 scopes", { exact: true });
    const list = card("Persönlich").getByText(scopes.join(", "), { exact: true });
    await expect(summary).toBeVisible();
    await expect(list).toBeHidden();
    await summary.click();
    await expect(list).toBeVisible();
  });
}
