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

test("session toolbar displays expiry and revokes its internal access", async ({
  page,
}) => {
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
      expiresAt: Date.UTC(2099, 0, 1),
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
  await page.getByRole("button", { name: "AgentPier-Werkzeuge", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Aktiv", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Läufe starten", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Zugriff widerrufen", exact: true }).click();
  await expect(dialog.getByText("Widerrufen", { exact: true })).toBeVisible();
  expect(revocations).toBe(1);
});
