import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { mcpFixture } from "./mcp-fixture.js";
test("HTTPS setup copy, CLI deep links and grant pages survive reload without writes", async ({
  page,
}) => {
  const state = await mcpFixture(page);
  await page.goto(baseURL + "/settings/mcp");
  await expect(
    page.getByRole("heading", { name: "MCP & Zugriffe", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Hinzufügen kopieren", exact: true }).click();
  expect(await page.evaluate(() => window.copiedText)).toBe(
    "codex mcp add agentpier --url 'https://agentpier.example.test/mcp'",
  );
  await page.getByRole("tab", { name: "OpenCode", exact: true }).click();
  await expect(page).toHaveURL(/cli=opencode/);
  await page.reload();
  await expect(page.getByRole("tab", { name: "OpenCode", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText('"type": "remote"', { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Nächste Zugriffe", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByText("Client 20", { exact: true })).toBeVisible();
  expect(state.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
});
test("mobile consent requires explicit resources and excludes publication by default", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await mcpFixture(page);
  await page.goto(baseURL + "/settings/mcp?authorization=auth-one");
  await expect(
    page.getByRole("heading", { name: "Zugriff freigeben", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Veröffentlichen", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Testprojekt", { exact: true })).not.toBeChecked();
  await page.getByLabel("Testprojekt", { exact: true }).check();
  await page.getByLabel("Testkonto", { exact: true }).check();
  await page.getByLabel("Läufe starten", { exact: true }).check();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.getByRole("button", { name: "Auswahl freigeben", exact: true }).click();
  await expect(page).toHaveURL(/127.0.0.1:19876\/callback/);
  expect(state.calls.find((call) => call.path.endsWith("/approve")).body).toEqual({
    scopes: ["catalog:read", "runs:read", "runs:start"],
    projectIds: ["project-one"],
    accountIds: ["account-one"],
    connectionIds: [],
  });
});
test("revoke refreshes a grant and reload never repeats the mutation", async ({
  page,
}) => {
  const state = await mcpFixture(page);
  await page.goto(baseURL + "/settings/mcp");
  const grant = page.getByRole("article").filter({ hasText: "Codex <untrusted>" });
  await grant.getByRole("button", { name: "Zugriff widerrufen", exact: true }).click();
  await grant.getByRole("button", { name: "Widerruf bestätigen", exact: true }).click();
  await expect(grant.getByText("Widerrufen", { exact: true })).toBeVisible();
  await page.reload();
  expect(state.calls.filter((call) => call.path.endsWith("/revoke"))).toHaveLength(1);
});
test("missing HTTPS blocks setup and expired consent cannot be approved", async ({
  page,
}) => {
  const state = await mcpFixture(page);
  state.available = false;
  await page.goto(baseURL + "/settings/mcp");
  await expect(
    page.getByText("HTTPS-Verbindung einrichten", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Hinzufügen kopieren", exact: true }),
  ).toHaveCount(0);
  state.available = true;
  state.fail = "/api/mcp-access/authorizations/auth-one";
  await page.goto(baseURL + "/settings/mcp?authorization=auth-one");
  await expect(page.getByRole("alert")).toContainText("Diese Anfrage ist abgelaufen.");
  await expect(
    page.getByRole("button", { name: "Auswahl freigeben", exact: true }),
  ).toHaveCount(0);
});
test("denial returns to the CLI and failed approval stays reviewable", async ({
  page,
}) => {
  const state = await mcpFixture(page);
  await page.goto(baseURL + "/settings/mcp?authorization=auth-one");
  state.fail = "/api/mcp-access/authorizations/auth-one/approve";
  await page.getByRole("button", { name: "Auswahl freigeben", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Diese Anfrage ist abgelaufen.");
  await page.getByRole("button", { name: "Ablehnen", exact: true }).click();
  await expect(page).toHaveURL(/127.0.0.1:19876\/callback/);
  expect(state.calls.filter((call) => call.path.endsWith("/deny"))).toHaveLength(1);
});
test("copy failure offers manual copying and keyboard tabs retain the selected CLI", async ({
  page,
}) => {
  await mcpFixture(page);
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    }),
  );
  await page.goto(baseURL + "/settings/mcp");
  await page
    .getByRole("button", { name: "HTTPS-MCP-Adresse kopieren", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Kopieren fehlgeschlagen");
  await page.getByRole("tab", { name: "Codex", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Claude Code", exact: true })).toBeFocused();
  await expect(page.getByRole("tabpanel")).toContainText(
    "claude mcp add --transport http --scope user",
  );
});
test("failed revocation leaves the grant active and retry revokes it once", async ({
  page,
}) => {
  const state = await mcpFixture(page);
  await page.goto(baseURL + "/settings/mcp");
  const grant = page.getByRole("article").filter({ hasText: "Codex <untrusted>" });
  await grant.getByRole("button", { name: "Zugriff widerrufen", exact: true }).click();
  state.fail = "/api/mcp-access/grants/grant-0/revoke";
  await grant.getByRole("button", { name: "Widerruf bestätigen", exact: true }).click();
  await expect(grant.getByRole("alert")).toBeVisible();
  await expect(grant.getByText("Aktiv", { exact: true })).toBeVisible();
  state.fail = "";
  await grant.getByRole("button", { name: "Widerruf bestätigen", exact: true }).click();
  await expect(grant.getByText("Widerrufen", { exact: true })).toBeVisible();
});
test("consent reload stays read-only and explicit publication and provider choices are submitted", async ({
  page,
}) => {
  const state = await mcpFixture(page);
  await page.goto(baseURL + "/settings/mcp?authorization=auth-one");
  await page.reload();
  await page.getByLabel("Veröffentlichen", { exact: true }).check();
  await page.getByLabel("Testanbieter", { exact: true }).check();
  expect(state.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  await page.getByRole("button", { name: "Auswahl freigeben", exact: true }).click();
  await expect(page).toHaveURL(/127.0.0.1:19876\/callback/);
  const approval = state.calls.find((call) => call.path.endsWith("/approve"));
  expect(approval.body.scopes).toEqual(["catalog:read", "runs:read", "runs:publish"]);
  expect(approval.body.connectionIds).toEqual(["connection-one"]);
  expect(approval.body.projectIds).toEqual([]);
});
test("failed MCP settings load can be retried without a mutation", async ({ page }) => {
  const state = await mcpFixture(page);
  state.fail = "/api/mcp-access";
  await page.goto(baseURL + "/settings/mcp");
  await expect(page.getByRole("alert")).toBeVisible();
  state.fail = "";
  await page.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Coding-CLI verbinden", exact: true }),
  ).toBeVisible();
  expect(state.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
});
test("local HTTP setup copies the fixed loopback endpoint and explains same-machine use", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await mcpFixture(page);
  state.mcpUrl = "http://127.0.0.1:4389/mcp";
  await page.goto(baseURL + "/settings/mcp");
  await expect(
    page.getByText("Diese HTTP-Adresse funktioniert nur", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Lokale MCP-Adresse kopieren", exact: true })
    .click();
  expect(await page.evaluate(() => window.copiedText)).toBe("http://127.0.0.1:4389/mcp");
  await page.getByRole("button", { name: "Hinzufügen kopieren", exact: true }).click();
  expect(await page.evaluate(() => window.copiedText)).toBe(
    "codex mcp add agentpier --url 'http://127.0.0.1:4389/mcp'",
  );
  await expect(
    page.getByText("Anmeldung bei Bedarf wiederholen", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  expect(state.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
});
test("unsafe remote HTTP never becomes a local setup command", async ({ page }) => {
  const state = await mcpFixture(page);
  state.mcpUrl = "http://agentpier.example.test:4389/mcp";
  await page.goto(baseURL + "/settings/mcp");
  await expect(
    page.getByText("HTTPS-Verbindung einrichten", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Hinzufügen kopieren", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Lokale MCP-Adresse kopieren", exact: true }),
  ).toHaveCount(0);
});
