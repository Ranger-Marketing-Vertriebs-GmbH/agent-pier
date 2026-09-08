import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./providers-fixture.js";
function nativeAccounts(controls) {
  controls.state.accounts = ["codex", "claude", "opencode"].map((tool) => ({
    id: `local-${tool}`,
    name: `Native ${tool}`,
    tool,
    kind: "local",
  }));
}
test("a central provider connection stores one key without choosing a CLI or model and preserves edits on failure", async ({
  page,
}) => {
  const controls = await fixture(page);
  nativeAccounts(controls);
  await page.goto(baseURL + "/accounts");
  await page
    .getByRole("button", { name: "Provider-Zugang hinzufügen", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name des Zugangs", { exact: true }).fill("Shared OpenRouter");
  await dialog.getByLabel("API-Anbieter", { exact: true }).selectOption("openrouter");
  await dialog.getByLabel("API-Key", { exact: true }).fill("fixture-central-key");
  await expect(dialog.getByLabel("Anbietermodell", { exact: true })).toHaveCount(0);
  controls.failConnection = true;
  await dialog.getByRole("button", { name: "Zugang speichern", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Fixture connection conflict");
  await expect(dialog.getByLabel("Name des Zugangs", { exact: true })).toHaveValue(
    "Shared OpenRouter",
  );
  controls.failConnection = false;
  await dialog.getByRole("button", { name: "Zugang speichern", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    controls.calls
      .filter(
        (call) => call.path === "/api/provider-connections" && call.method === "POST",
      )
      .at(-1).body,
  ).toEqual({
    name: "Shared OpenRouter",
    providerId: "openrouter",
    apiKey: "fixture-central-key",
  });
  await expect(page.locator("body")).not.toContainText("fixture-central-key");
  await page
    .getByRole("button", { name: "Shared OpenRouter bearbeiten", exact: true })
    .click();
  await expect(page.getByLabel("API-Key", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Zugang speichern", exact: true }).click();
  expect(controls.calls.filter((call) => call.method === "PATCH").at(-1).body).toEqual({
    name: "Shared OpenRouter",
  });
});
test("mobile launch selects the CLI before compatible access and shares one connection across CLIs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const controls = await fixture(page);
  nativeAccounts(controls);
  controls.state.providerConnections = [
    {
      id: "router",
      name: "Shared OpenRouter",
      providerId: "openrouter",
      hasSecret: true,
      tools: ["codex", "claude", "opencode"],
    },
    {
      id: "zai",
      name: "Z.ai no Responses",
      providerId: "zai",
      hasSecret: true,
      tools: ["claude", "opencode"],
    },
  ];
  await page.goto(baseURL + "/");
  await page
    .locator(".mobile-header")
    .getByRole("button", { name: "Neue Sitzung", exact: true })
    .click();
  await page.getByLabel("CLI", { exact: true }).selectOption("codex");
  const access = page.getByLabel("Zugang", { exact: true });
  await expect(access.locator('option[value="local-claude"]')).toHaveCount(0);
  await expect(access.locator('option[value="provider:zai"]')).toHaveCount(0);
  await access.selectOption("provider:router");
  await page.getByLabel("Modelle suchen", { exact: true }).fill("glm");
  await page.getByLabel("Anbietermodell", { exact: true }).selectOption("z-ai/glm-5.3");
  await expect(page.getByRole("group", { name: "Modellgrenzen" })).toContainText(
    "1.310.720",
  );
  await page.getByLabel("CLI", { exact: true }).selectOption("claude");
  await expect(access).toHaveValue("local-claude");
  await expect(page.getByLabel("Anbietermodell", { exact: true })).toHaveCount(0);
  await access.selectOption("provider:router");
  await page.getByLabel("Anbietermodell", { exact: true }).selectOption("z-ai/glm-5.3");
  await page.getByLabel("Arbeitsverzeichnis", { exact: true }).fill("/fixture");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Sitzung starten", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const body = controls.calls.find(
    (call) => call.path === "/api/sessions" && call.method === "POST",
  ).body;
  expect(body).toMatchObject({
    tool: "claude",
    providerConnectionId: "router",
    providerModelId: "z-ai/glm-5.3",
    launchMode: "auto",
  });
  expect(body).not.toHaveProperty("accountId");
  expect(body).not.toHaveProperty("apiKey");
  await expect(page.locator(".session-heading")).toContainText("Shared OpenRouter");
  await expect(page.locator("body")).not.toContainText("internal-isolated-profile");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
test("missing keys cannot be selected or launched and native model IDs remain session-specific", async ({
  page,
}) => {
  const controls = await fixture(page);
  nativeAccounts(controls);
  controls.state.providerConnections = [
    {
      id: "no-key",
      name: "Missing key",
      providerId: "openrouter",
      hasSecret: false,
      tools: ["codex", "claude", "opencode"],
    },
  ];
  await page.goto(baseURL + "/");
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Neue Sitzung", exact: true })
    .click();
  const access = page.getByLabel("Zugang", { exact: true });
  await access.click();
  await expect(page.getByRole("option", { name: /Missing key/ })).toBeDisabled();
  await access.press("End");
  await access.press("Enter");
  await expect(access).toHaveValue("local-codex");
  await page
    .getByLabel("Natives Modell (optional)", { exact: true })
    .fill("native-model-fixture");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Sitzung starten", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const body = controls.calls.find(
    (call) => call.path === "/api/sessions" && call.method === "POST",
  ).body;
  expect(body).toMatchObject({
    tool: "codex",
    accountId: "local-codex",
    nativeModelId: "native-model-fixture",
  });
  expect(body).not.toHaveProperty("providerConnectionId");
});
test("central connection rotation removal and deletion preserve one immutable provider identity", async ({
  page,
}) => {
  const controls = await fixture(page);
  nativeAccounts(controls);
  controls.state.providerConnections = [
    {
      id: "zai-one",
      name: "Shared Z.ai",
      providerId: "zai",
      hasSecret: true,
      tools: ["claude", "opencode"],
      responsesAccess: false,
    },
  ];
  await page.goto(baseURL + "/accounts");
  await page.getByRole("button", { name: "Shared Z.ai bearbeiten", exact: true }).click();
  await expect(page.getByLabel("API-Anbieter", { exact: true })).toBeDisabled();
  await page.getByLabel("API-Key", { exact: true }).fill("fixture-rotation");
  await page.getByLabel("Responses-API-Zugang bestätigt", { exact: true }).check();
  await page.getByRole("button", { name: "Zugang speichern", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(controls.calls.filter((call) => call.method === "PATCH").at(-1).body).toEqual({
    name: "Shared Z.ai",
    apiKey: "fixture-rotation",
    responsesAccess: true,
  });
  await expect(page.locator(".provider-connection-card")).toContainText("Codex");
  await page.getByRole("button", { name: "Shared Z.ai bearbeiten", exact: true }).click();
  await page.getByLabel("Gespeicherten API-Key entfernen", { exact: true }).check();
  await page.getByRole("button", { name: "Zugang speichern", exact: true }).click();
  await expect(page.locator(".provider-connection-card")).toContainText("API-Key fehlt");
  expect(controls.calls.filter((call) => call.method === "PATCH").at(-1).body).toEqual({
    name: "Shared Z.ai",
    removeApiKey: true,
  });
  await page.getByRole("button", { name: "Shared Z.ai löschen", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Zugang löschen", exact: true })
    .click();
  await expect(page.locator(".provider-connection-card")).toHaveCount(0);
});
