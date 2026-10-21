import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { settingsRow } from "../helpers/settings.js";
import { operationsFixture } from "./operations-fixture.js";

for (const locale of ["de-DE", "en-GB"]) {
  const en = locale === "en-GB";
  const t = (german, english) => (en ? english : german);
  test.describe(`settings tabs ${locale}`, () => {
    test.use({ locale });

    test("operations rows show their state and open subpages with a way back", async ({
      page,
    }) => {
      await operationsFixture(page);
      await page.goto(baseURL + "/settings?tab=operations");
      await expect(
        page.getByRole("tab", { name: t("Betrieb", "Operations") }),
      ).toHaveAttribute("aria-selected", "true");
      await expect(settingsRow(page, t("Diagnose", "Diagnostics"))).toContainText(
        t("In Ordnung", "OK"),
      );
      const backups = settingsRow(page, t("Sicherungen", "Backups"));
      await expect(backups).toContainText("4");
      await expect(backups).toContainText(t("Letzte Sicherung", "Last backup"));
      await expect(settingsRow(page, "Updates")).toContainText(
        t("1.1.0 verfügbar", "1.1.0 available"),
      );
      await expect(
        settingsRow(page, t("Aktivitätsprotokoll", "Activity log")),
      ).toContainText(t("Besitzer, Benutzer, System, MCP", "Owner, users, system, MCP"));
      await settingsRow(page, "Updates").click();
      await expect(page).toHaveURL(/\/settings\/updates$/);
      await expect(
        page.getByRole("heading", { level: 1, name: "Updates", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(t("Einstellungen · Betrieb", "Settings · Operations"), {
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByRole("button", {
          name: t("Zurück zu Betrieb", "Back to Operations"),
          exact: true,
        })
        .click();
      await expect(page).toHaveURL(/\/settings\?tab=operations$/);
    });

    test("access rows show counts and link the central accounts", async ({ page }) => {
      await operationsFixture(page);
      await page.goto(baseURL + "/settings?tab=access");
      await expect(settingsRow(page, t("MCP & Zugriffe", "MCP & access"))).toContainText(
        t("2 verbundene Clients", "2 connected clients"),
      );
      await expect(settingsRow(page, t("Fernzugriff", "Remote access"))).toContainText(
        "Tailscale",
      );
      await expect(settingsRow(page, t("SSH-Zugänge", "SSH accesses"))).toContainText(
        "3",
      );
      const github = settingsRow(page, t("GitHub-Zugänge", "GitHub connections"));
      await expect(github).toContainText("1");
      await expect(
        page.getByRole("link", {
          name: new RegExp(
            t("Provider-Zugänge, MCP-Server", "Provider access, MCP servers"),
          ),
        }),
      ).toHaveAttribute("href", "/accounts?returnTo=%2Fsettings%3Ftab%3Daccess");
      await github.click();
      await expect(page).toHaveURL(/\/settings\/github$/);
    });

    test("unknown summary parts show a dash while a real zero stays zero", async ({
      page,
    }) => {
      const state = await operationsFixture(page);
      state.summary = {
        access: {
          mcp: null,
          remote: { tailscale: false, network: false },
          ssh: null,
          github: { count: 0 },
        },
        operations: null,
      };
      await page.goto(baseURL + "/settings?tab=access");
      await expect(settingsRow(page, t("MCP & Zugriffe", "MCP & access"))).toContainText(
        "—",
      );
      await expect(settingsRow(page, t("Fernzugriff", "Remote access"))).toContainText(
        t("Lokal", "Local"),
      );
      await expect(settingsRow(page, t("SSH-Zugänge", "SSH accesses"))).toContainText(
        "—",
      );
      await expect(
        settingsRow(page, t("GitHub-Zugänge", "GitHub connections")),
      ).toContainText("0");
      await page.route("**/api/settings/summary", (route) =>
        route.fulfill({ status: 500, json: { error: "Summary down" } }),
      );
      await page.getByRole("tab", { name: t("Betrieb", "Operations") }).click();
      for (const label of [
        t("Diagnose", "Diagnostics"),
        t("Sicherungen", "Backups"),
        "Updates",
      ])
        await expect(settingsRow(page, label)).toContainText("—");
    });

    test("contradicting addresses and history settle on one tab", async ({ page }) => {
      await operationsFixture(page);
      await page.goto(baseURL + "/settings/diagnostics?tab=access");
      await expect(page).toHaveURL(/\/settings\/diagnostics$/);
      await expect(
        page.getByText(t("Einstellungen · Betrieb", "Settings · Operations"), {
          exact: true,
        }),
      ).toBeVisible();
      await page.goto(baseURL + "/settings");
      const workspace = page.getByRole("tab", { name: t("Arbeitsbereich", "Workspace") });
      await expect(workspace).toHaveAttribute("aria-selected", "true");
      await page.getByRole("tab", { name: t("Zugriff", "Access") }).click();
      await expect(page).toHaveURL(/\/settings\?tab=access$/);
      await page.goBack();
      await expect(page).toHaveURL(/\/settings$/);
      await expect(workspace).toHaveAttribute("aria-selected", "true");
    });
  });
}

test.describe("settings on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("the page header opens navigation and subpages lead back", async ({ page }) => {
    await operationsFixture(page);
    await page.goto(baseURL + "/settings?tab=operations");
    await expect(page.getByRole("tabpanel")).toBeVisible();
    await expect(page.locator(".mobile-header")).toBeHidden();
    await page.getByRole("button", { name: "Navigation öffnen", exact: true }).click();
    await expect(page.locator(".sidebar")).toHaveClass(/\bopen\b/);
    await page.keyboard.press("Escape");
    await expect(page.locator(".sidebar")).not.toHaveClass(/\bopen\b/);
    const fits = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    expect(await fits()).toBe(true);
    await settingsRow(page, "Sicherungen").click();
    await expect(
      page.getByRole("button", { name: "Zurück zu Betrieb", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Navigation öffnen", exact: true }),
    ).toBeHidden();
    expect(await fits()).toBe(true);
  });

  test("the update notice stays clear of the settings tabs", async ({ page }) => {
    await operationsFixture(page);
    await page.goto(baseURL + "/settings");
    await expect(page.getByRole("tablist")).toBeVisible();
    await page.evaluate(() =>
      window.dispatchEvent(new Event("agentpier-update-available")),
    );
    const notice = page.locator(".update-notice");
    await expect(notice).toBeVisible();
    // With the global header hidden the notice sits at the top, not 62px lower.
    expect((await notice.boundingBox()).y).toBeLessThan(20);
  });
});

test.describe("settings subpage structure", () => {
  test.use({ locale: "en-GB" });
  // Levels below the page title never skip one (h1 → h2 → h3).
  const headingGaps = (page) =>
    page.evaluate(() => {
      const levels = [...document.querySelectorAll("main :is(h1,h2,h3,h4,h5,h6)")]
        .filter((heading) => heading.getClientRects().length)
        .map((heading) => Number(heading.tagName[1]));
      return levels.filter((level, index) => index && level > levels[index - 1] + 1);
    });

  test("subpages keep heading levels without gaps", async ({ page }) => {
    const state = await operationsFixture(page);
    state.report = {
      version: 1,
      generatedAt: "2026-09-07T12:00:00Z",
      checks: [{ id: "tmux", status: "warn", summary: "Missing", remedy: "Install" }],
    };
    state.backups.push({
      id: "backup-one",
      createdAt: "2026-09-07T12:00:00Z",
      bytes: 4096,
    });
    for (const [section, marker] of [
      ["remote", ".remote-settings h2"],
      ["diagnostics", ".operations-card h2"],
      ["backups", ".operations-card h2"],
      ["github", ".github-access-page"],
    ]) {
      await page.goto(baseURL + "/settings/" + section);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.locator(marker).first()).toBeVisible();
      expect(await headingGaps(page), section).toEqual([]);
    }
  });

  test("the update channel label matches the other group labels", async ({ page }) => {
    await operationsFixture(page);
    await page.goto(baseURL + "/settings");
    const size = (locator) =>
      locator.evaluate((element) => getComputedStyle(element).fontSize);
    const reference = await size(page.locator(".group-label :is(h2,h3,h4)").first());
    await page.goto(baseURL + "/settings/updates");
    const channel = page.locator(".group-label :is(h2,h3,h4)").first();
    await expect(channel).toBeVisible();
    expect(await size(channel)).toBe(reference);
  });
});
