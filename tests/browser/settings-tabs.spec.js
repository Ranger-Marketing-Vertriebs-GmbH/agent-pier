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

    test("the former Access tab leads to Zugänge and its pages to their new places", async ({
      page,
    }) => {
      // Settings › Zugriff moved (handoff §4.2): the tab opens Zugänge, SSH, secrets
      // and GitHub are Zugänge categories, MCP access is in Coding.
      // The tab itself is covered by the history test below and the Accounts specs.
      await operationsFixture(page);
      await page.goto(baseURL + "/settings/github");
      await expect(page).toHaveURL(/\/connections\?section=github$/);
      await expect(
        page.getByRole("heading", {
          level: 2,
          name: t("GitHub-Zugänge", "GitHub connections"),
          exact: true,
        }),
      ).toBeVisible();
      // The counts the Access tab showed (3 SSH accesses, 1 GitHub profile) are in
      // Zugänge's categories column.
      const categories = page.getByRole("navigation", {
        name: t("Kategorien", "Categories"),
      });
      await expect(
        categories.getByRole("link", {
          name: t(/^GitHub-Zugänge/, /^GitHub connections/),
        }),
      ).toContainText("1");
      await expect(
        categories.getByRole("link", { name: t(/^Geheimnisse/, /^Secrets/) }),
      ).toContainText("2");
      // Fernzugriff stayed: it is a settings tab now, at its old address.
      await page.goto(baseURL + "/settings/remote");
      await expect(page).toHaveURL(/\/settings\/remote$/);
      await expect(
        page.getByRole("tab", { name: t("Fernzugriff", "Remote access") }),
      ).toHaveAttribute("aria-selected", "true");
    });

    test("five tabs; App, Benutzer and Fernzugriff show their page at its address", async ({
      page,
    }) => {
      await operationsFixture(page);
      await page.goto(baseURL + "/settings");
      await expect(page.getByRole("tab")).toHaveText([
        t("Allgemein", "General"),
        t("App & Benachrichtigungen", "App and notifications"),
        t("Benutzer", "Users"),
        t("Fernzugriff", "Remote access"),
        t("Betrieb", "Operations"),
      ]);
      for (const [tab, address, marker] of [
        [
          t("App & Benachrichtigungen", "App and notifications"),
          "/settings/notifications",
          ".notifications-page",
        ],
        [t("Benutzer", "Users"), "/settings/users", ".users-page"],
        [t("Fernzugriff", "Remote access"), "/settings/remote", ".remote-settings"],
      ]) {
        await page.getByRole("tab", { name: tab, exact: true }).click();
        await expect(page).toHaveURL((url) => url.pathname === address && !url.search);
        await expect(page.getByRole("tab", { name: tab, exact: true })).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await expect(page.getByRole("tabpanel").locator(marker).first()).toBeVisible();
        await expect(
          page.getByRole("heading", { level: 1, name: t("Einstellungen", "Settings") }),
        ).toBeVisible();
      }
      // ?tab= names the same tabs.
      await page.goto(baseURL + "/settings?tab=users");
      await expect(page).toHaveURL(/\/settings\/users$/);
      await page.goto(baseURL + "/settings?tab=workspace");
      await expect(page).toHaveURL(/\/settings$/);
      await expect(
        page.getByRole("tab", { name: t("Allgemein", "General") }),
      ).toHaveAttribute("aria-selected", "true");
    });

    test("Umgezogen links the moved pages and counts MCP clients", async ({ page }) => {
      await operationsFixture(page);
      await page.goto(baseURL + "/settings");
      const mcp = settingsRow(
        page,
        t("MCP & Zugriffe (AgentPier für CLIs)", "MCP & access (AgentPier for CLIs)"),
      );
      await expect(mcp).toContainText(t("2 verbundene Clients", "2 connected clients"));
      await expect(mcp).toHaveAttribute(
        "href",
        "/coding/clis?tab=mcp&returnTo=%2Fsettings",
      );
      const runtime = settingsRow(
        page,
        t(
          "Agentendienst, Updates, Träumen, Erweitert",
          "Agent service, updates, dreaming, advanced",
        ),
      );
      await expect(runtime).toHaveAttribute("href", /^\/agents\?tab=runtime/);
      // Funktionen holds the one "Agenten · An/Aus" row; it leads to Laufzeit too.
      const features = page.getByRole("group", {
        name: t("Funktionen", "Features"),
        exact: true,
      });
      await expect(features.getByRole("link")).toHaveCount(1);
      await expect(features.getByRole("link")).toHaveAttribute(
        "href",
        "/agents?tab=runtime",
      );
      await expect(features.getByRole("link")).toContainText(
        t(
          "Ein- und ausschalten unter Agenten › Laufzeit",
          "Turn on and off under Agents › Runtime",
        ),
      );
      await expect(features.getByRole("link")).toContainText(t("Aus", "Off"));
      await runtime.click();
      await expect(page).toHaveURL(/\/agents\?tab=runtime&returnTo=%2Fsettings$/);
      await expect(
        page.getByRole("switch", { name: t("Agenten aktivieren", "Enable agents") }),
      ).toBeVisible();
      await page.goBack();
      const connections = settingsRow(
        page,
        t(
          "SSH-Zugänge, Geheimnisse, GitHub-Zugänge",
          "SSH accesses, secrets, GitHub connections",
        ),
      );
      await connections.click();
      await expect(page).toHaveURL(/\/connections\?returnTo=%2Fsettings$/);
    });

    test("unknown MCP clients show a dash while a real zero stays zero", async ({
      page,
    }) => {
      const state = await operationsFixture(page);
      state.summary = { access: { mcp: null }, operations: null };
      await page.goto(baseURL + "/settings");
      const label = t(
        "MCP & Zugriffe (AgentPier für CLIs)",
        "MCP & access (AgentPier for CLIs)",
      );
      await expect(settingsRow(page, label)).toContainText("—");
      state.summary = { access: { mcp: { available: true, activeGrants: 0 } } };
      await page.reload();
      await expect(settingsRow(page, label)).toContainText(
        t("0 verbundene Clients", "0 connected clients"),
      );
      state.summary = { access: { mcp: { available: false, activeGrants: 0 } } };
      await page.reload();
      await expect(settingsRow(page, label)).toContainText(
        t("Nicht verfügbar", "Not available"),
      );
    });

    test("Betrieb › Speicher shows the free space and opens the clean-up", async ({
      page,
    }) => {
      await operationsFixture(page);
      await page.goto(baseURL + "/settings?tab=operations");
      const storage = page.getByRole("button", {
        name: new RegExp(`^${t("Speicher", "Storage")}`),
      });
      await expect(storage).toContainText(
        t("200 GB frei", "200 GB free").replace(" ", "\u00a0"),
      );
      await storage.click();
      const dialog = page.getByRole("dialog", {
        name: t("Systemstatus", "System status"),
      });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("heading", { name: t("Speicher freigeben", "Free up space") }),
      ).toBeInViewport();
      await dialog
        .getByRole("button", { name: t("Schließen", "Close") })
        .first()
        .click();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(/\/settings\?tab=operations$/);
    });

    test("unknown operations summary parts show a dash", async ({ page }) => {
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
      await page.goto(baseURL + "/settings");
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
      const workspace = page.getByRole("tab", { name: t("Allgemein", "General") });
      await expect(workspace).toHaveAttribute("aria-selected", "true");
      // The Access tab moved to Zugänge; history leads back to the settings tab.
      await expect(
        page.getByRole("tab", { name: t("Zugriff", "Access"), exact: true }),
      ).toHaveCount(0);
      await page.goto(baseURL + "/settings?tab=access");
      await expect(page).toHaveURL(/\/connections$/);
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
