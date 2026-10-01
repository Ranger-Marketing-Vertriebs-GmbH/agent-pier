import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./ssh-fixture.js";

for (const mobile of [false, true])
  test(`session MCP defaults on with one checkbox and preserves opt-out after failed launch (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await fixture(page);
    const launches = [];
    await page.route("**/api/sessions", (route) => {
      launches.push(route.request().postDataJSON());
      return route.fulfill({ status: 409, json: { error: "Launch rejected" } });
    });
    await page.goto(baseURL);
    await (mobile ? page.getByRole("main") : page)
      .getByRole("button", { name: "Neue Sitzung", exact: true })
      .click();
    await page.locator(".launch-extensions > summary").click();
    const enabled = page.getByRole("checkbox", { name: /AgentPier-Werkzeuge/ });
    await expect(enabled).toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: "Läufe starten", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("checkbox", { name: "Veröffentlichen", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await enabled.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `docs/screenshots/session-mcp-${mobile ? "mobile" : "desktop"}.png`,
      fullPage: true,
    });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Sitzung starten", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("Launch rejected");
    expect(launches[0].agentpierTools).toBe(true);
    await enabled.uncheck();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Sitzung starten", exact: true })
      .click();
    await expect.poll(() => launches.length).toBe(2);
    expect(launches[1].agentpierTools).toBe(false);
    await expect(enabled).not.toBeChecked();
  });

for (const language of ["de", "en"])
  for (const legacy of [false, true])
    test(`session toolbar keeps ${legacy ? "legacy expired" : "new"} access active until revoked (${language})`, async ({
      page,
    }) => {
      await page.addInitScript(
        (language) => localStorage.setItem("agentpier-language", language),
        language,
      );
      const english = language === "en";
      await fixture(page);
      const session = {
        id: "fixture-session",
        name: "Composer",
        tool: "codex",
        accountId: "local-codex",
        status: "running",
        cwd: "/fixture",
        nativeRequests: { enabled: true, version: 1 },
        agentpierTools: {
          enabled: true,
          generation: "fixture-generation",
          ...(legacy ? { expiresAt: Date.UTC(2000, 0, 1) } : {}),
          selection: {
            scopes: ["catalog:read", "runs:start"],
            projectIds: [],
            accountIds: ["local-codex"],
            connectionIds: [],
            currentProject: true,
          },
        },
      };
      await page.route("**/api/state", (route) =>
        route.fulfill({
          json: {
            tools: [{ id: "codex", name: "Codex", installed: true }],
            accounts: [
              { id: "local-codex", tool: "codex", kind: "local", name: "Codex lokal" },
            ],
            sessions: [session],
            home: "/fixture",
            defaultCwd: "/fixture",
          },
        }),
      );
      let revocations = 0;
      await page.route("**/api/sessions/fixture-session/mcp", (route) => {
        expect(route.request().method()).toBe("DELETE");
        revocations++;
        session.agentpierTools.enabled = false;
        return route.fulfill({ json: session });
      });
      await page.goto(baseURL + "/sessions/fixture-session");
      await page
        .getByRole("button", {
          name: english ? "AgentPier tools" : "AgentPier-Werkzeuge",
          exact: true,
        })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByText(english ? "Active" : "Aktiv", { exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByText(english ? "Start runs" : "Läufe starten", { exact: true }),
      ).toBeVisible();
      await expect(dialog).toContainText(
        english ? "with no time limit" : "ohne Zeitlimit",
      );
      await expect(dialog).not.toContainText(english ? "Expires on" : "Gültig bis");
      await expect(
        dialog.getByText(english ? "Expired" : "Abgelaufen", { exact: true }),
      ).toHaveCount(0);
      if (english && legacy)
        await page.screenshot({
          path: "docs/screenshots/session-mcp-access-en.png",
          fullPage: true,
        });
      await dialog
        .getByRole("button", {
          name: english ? "Revoke access" : "Zugriff widerrufen",
          exact: true,
        })
        .click();
      await expect(
        dialog.getByText(english ? "Revoked" : "Widerrufen", { exact: true }),
      ).toBeVisible();
      expect(revocations).toBe(1);
    });
