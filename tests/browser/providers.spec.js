import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

import { fixture, createForm } from "./providers-fixture.js";

for (const tool of ["codex", "claude", "opencode"])
  test(`${tool} edits a legacy provider account with an exact model with read-only catalog limits`, async ({
    page,
  }) => {
    const controls = await fixture(page);
    await createForm(page, tool, controls);
    await page.getByLabel("API-Anbieter", { exact: true }).selectOption("openrouter");
    await page.getByLabel("Modelle suchen", { exact: true }).fill("glm");
    await page.getByLabel("Anbietermodell", { exact: true }).selectOption("z-ai/glm-5.3");
    const details = page.getByRole("group", { name: "Modellgrenzen" });
    await expect(details).toContainText("1.310.720");
    await expect(details).toContainText("1.048.576");
    await expect(details).toContainText("262.144");
    await expect(
      page.getByRole("dialog").getByText("Gebündelter Katalog", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Responses-API-Zugang bestätigt")).toHaveCount(0);
    await page
      .getByLabel("API-Key (optional)", { exact: true })
      .fill("fixture-private-key");
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Gateway account", exact: true }),
    ).toBeVisible();
    const body = controls.calls.find(
      (c) => c.path === "/api/accounts/legacy-gateway" && c.method === "PATCH",
    ).body;
    expect(body).toEqual({
      name: "Gateway account",
      apiKey: "fixture-private-key",
      provider: { id: "openrouter", modelId: "z-ai/glm-5.3" },
    });
    expect(
      controls.calls.some(
        (c) => c.path === "/api/providers/openrouter/models" && c.tool === tool,
      ),
    ).toBe(true);
    await expect(page.locator("body")).not.toContainText("fixture-private-key");
    await expect(page.locator(".account-card")).toContainText("z-ai/glm-5.3");
  });

for (const id of ["zai", "zai-coding-plan"])
  test(`Codex ${id} requires explicit Responses entitlement`, async ({ page }) => {
    const controls = await fixture(page);
    await createForm(page, "codex", controls);
    await page.getByLabel("API-Anbieter", { exact: true }).selectOption(id);
    await page.getByLabel("Anbietermodell", { exact: true }).selectOption("glm-5.3");
    await expect(
      page.getByRole("button", { name: "Speichern", exact: true }),
    ).toBeDisabled();
    await page.getByLabel("Responses-API-Zugang bestätigt").check();
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Gateway account", exact: true }),
    ).toBeVisible();
    expect(
      controls.calls.find(
        (c) => c.method === "PATCH" && c.path === "/api/accounts/legacy-gateway",
      ).body.provider,
    ).toEqual({ id, modelId: "glm-5.3", responsesAccess: true });
    await expect(page.locator(".account-card")).toContainText("API-Key fehlt");
    await expect(page.getByRole("button", { name: "Anmelden", exact: true })).toHaveCount(
      0,
    );
  });

test("catalog refresh failures preserve selection and unknown limits remain unknown", async ({
  page,
}) => {
  const controls = await fixture(page);
  await createForm(page, "claude", controls);
  await page.getByLabel("API-Anbieter", { exact: true }).selectOption("openrouter");
  await page
    .getByLabel("Anbietermodell", { exact: true })
    .selectOption("example/unknown");
  await expect(page.getByRole("group", { name: "Modellgrenzen" })).toContainText(
    "Nicht angegeben",
  );
  controls.failRefresh = true;
  await page.getByRole("button", { name: "Modellkatalog aktualisieren" }).click();
  await expect(page.getByRole("alert")).toContainText("Fixture catalog unavailable");
  await expect(page.getByLabel("Anbietermodell", { exact: true })).toHaveValue(
    "example/unknown",
  );
  await expect(page.getByLabel("Kontoname")).toHaveValue("Gateway account");
  controls.failRefresh = false;
  await page.getByRole("button", { name: "Modellkatalog aktualisieren" }).click();
  await expect(page.getByText("Aktueller Katalog", { exact: true })).toBeVisible();
});

test("provider account retains a blank key, rotates it, removes it and returns to native defaults", async ({
  page,
}) => {
  const account = {
    id: "gateway",
    name: "Gateway",
    kind: "managed",
    tool: "opencode",
    hasSecret: true,
    provider: { id: "openrouter", modelId: "z-ai/glm-5.3" },
  };
  const controls = await fixture(page, { account });
  await page.goto(baseURL + "/accounts");
  async function edit() {
    await page.getByRole("button", { name: "Gateway bearbeiten" }).click();
    await expect(page.getByLabel("Anbietermodell", { exact: true })).toHaveValue(
      "z-ai/glm-5.3",
    );
  }
  await edit();
  await expect(page.getByLabel("API-Key (optional)", { exact: true })).toBeEmpty();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    controls.calls.filter((c) => c.method === "PATCH").at(-1).body,
  ).not.toHaveProperty("apiKey");
  await edit();
  await page
    .getByLabel("API-Key (optional)", { exact: true })
    .fill("fixture-rotated-key");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(controls.calls.filter((c) => c.method === "PATCH").at(-1).body.apiKey).toBe(
    "fixture-rotated-key",
  );
  await edit();
  await page.getByLabel("Gespeicherten API-Key entfernen").check();
  await expect(page.getByLabel("API-Key (optional)", { exact: true })).toBeDisabled();
  await page.getByLabel("API-Anbieter", { exact: true }).selectOption("");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(controls.calls.filter((c) => c.method === "PATCH").at(-1).body).toEqual({
    name: "Gateway",
    provider: null,
    removeApiKey: true,
  });
});

test("changing providers ignores an older catalog response and fits a mobile dialog", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const controls = await fixture(page);
  await createForm(page, "opencode", controls);
  controls.holdProvider = "openrouter";
  await page.getByLabel("API-Anbieter", { exact: true }).selectOption("openrouter");
  await expect.poll(() => Boolean(controls.release)).toBe(true);
  await page.getByLabel("API-Anbieter", { exact: true }).selectOption("zai");
  await page.getByLabel("Anbietermodell", { exact: true }).selectOption("glm-5.3");
  controls.release();
  await expect(page.getByLabel("Anbietermodell", { exact: true })).toHaveValue("glm-5.3");
  await expect(
    page
      .getByLabel("Anbietermodell", { exact: true })
      .locator('option[value="z-ai/glm-5.3"]'),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("configured provider limits stay separate from native model confirmation and restart-only selection never blocks chat", async ({
  page,
}) => {
  const account = {
    id: "gateway",
    name: "Gateway",
    kind: "managed",
    tool: "claude",
    hasSecret: true,
    provider: { id: "zai", modelId: "glm-5.3" },
  };
  const session = {
    id: "gateway-session",
    name: "Provider session",
    tool: "claude",
    accountId: "gateway",
    cwd: "/fixture",
    status: "running",
    provider: {
      id: "zai",
      requestedModelId: "glm-5.3",
      cliModelId: "glm-5.3",
      effectiveModelId: null,
      contextTokens: 1000000,
      routingContextTokens: null,
      outputTokens: 131072,
      assumedContextTokens: 1000000,
      contextStatus: "configured",
      source: "https://models.dev/api.json",
      fetchedAt: "2026-09-06T10:00:00Z",
      modelChangeRequiresRestart: true,
    },
  };
  const controls = await fixture(page, { account, session });
  await page.goto(baseURL + "/sessions/gateway-session/chat");
  await expect(
    page.getByRole("button", { name: "Modell auswählen", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Modell auswählen", exact: true }),
  ).toContainText("native-confirmed-model");
  await expect(
    page.getByText("Konfiguriertes Anbietermodell: glm-5.3", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Modellwechsel benötigt eine neue Sitzung.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Nachricht", exact: true })
    .fill("Still usable");
  await page.getByRole("button", { name: "Senden", exact: true }).click();
  expect(
    controls.calls.filter((c) => c.path.includes("/models/") && c.method === "POST"),
  ).toEqual([]);
  await expect
    .poll(() => controls.calls.filter((c) => c.path.endsWith("/input")))
    .toHaveLength(1);
});

test("restart-only provider sessions can cancel a pending native picker without selecting another model", async ({
  page,
}) => {
  const session = {
    id: "pending-provider",
    name: "Pending provider",
    tool: "codex",
    accountId: "gateway",
    cwd: "/fixture",
    status: "running",
    provider: {
      id: "zai",
      requestedModelId: "glm-5.3",
      modelChangeRequiresRestart: true,
    },
  };
  const controls = await fixture(page, { session });
  controls.modelState = {
    currentModel: "glm-5.3",
    picker: {
      token: "pending-token",
      title: "Existing native picker",
      kind: "model",
      searchable: true,
      options: [{ id: "other", label: "Other model" }],
    },
    pending: false,
    modelChangeRequiresRestart: true,
    configuration: session.provider,
  };
  await page.goto(baseURL + "/sessions/pending-provider/chat");
  await expect(
    page.getByRole("button", { name: "Other model", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("textbox", { name: "Modelle suchen", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Auswahl abbrechen", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Modellauswahl", exact: true }),
  ).toHaveCount(0);
  expect(controls.calls.filter((call) => call.method === "POST")).toEqual([
    {
      path: "/api/sessions/pending-provider/models/cancel",
      method: "POST",
      body: { token: "pending-token" },
      tool: null,
    },
  ]);
});

test("provider cards expose stale catalog provenance and recover through refresh", async ({
  page,
}) => {
  const controls = await fixture(page, {
    account: {
      id: "gateway",
      name: "Gateway card",
      kind: "managed",
      tool: "codex",
      hasSecret: true,
      provider: { id: "openrouter", modelId: "z-ai/glm-5.3" },
    },
  });
  await page.goto(baseURL + "/accounts");
  const card = page.locator(".account-card");
  await card.getByText("Anbietermodell & Kontext", { exact: true }).click();
  await expect(card.getByText("Gebündelter Katalog", { exact: true })).toBeVisible();
  controls.failRefresh = true;
  await card.getByRole("button", { name: "Modellkatalog aktualisieren" }).click();
  await expect(card.getByRole("alert")).toContainText("Fixture catalog unavailable");
  await expect(card.getByRole("group", { name: "Modellgrenzen" })).toContainText(
    "1.310.720",
  );
  controls.failRefresh = false;
  await card.getByRole("button", { name: "Modellkatalog aktualisieren" }).click();
  await expect(card.getByText("Aktueller Katalog", { exact: true })).toBeVisible();
});

test("renaming a running provider account does not submit a provider change", async ({
  page,
}) => {
  const account = {
    id: "gateway",
    name: "Gateway",
    kind: "managed",
    tool: "opencode",
    hasSecret: true,
    provider: { id: "openrouter", modelId: "z-ai/glm-5.3" },
  };
  const controls = await fixture(page, {
    account,
    session: {
      id: "running-gateway",
      name: "Running",
      accountId: "gateway",
      tool: "opencode",
      status: "running",
      cwd: "/fixture",
    },
  });
  await page.goto(baseURL + "/accounts");
  await page.getByRole("button", { name: "Gateway bearbeiten" }).click();
  await page.getByLabel("Kontoname").fill("Renamed gateway");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Renamed gateway", exact: true }),
  ).toBeVisible();
  expect(controls.calls.filter((call) => call.method === "PATCH").at(-1).body).toEqual({
    name: "Renamed gateway",
  });
});

for (const unavailable of ["delisted", "unreachable"]) {
  test(`a saved key can be removed when its unchanged provider model is ${unavailable}`, async ({
    page,
  }) => {
    const controls = await fixture(page, {
      account: {
        id: "gateway",
        name: "Gateway",
        kind: "managed",
        tool: "opencode",
        hasSecret: true,
        provider: { id: "openrouter", modelId: "z-ai/glm-5.3" },
      },
    });
    if (unavailable === "delisted") controls.catalogs.openrouter = [];
    else controls.failCatalog = true;
    await page.goto(baseURL + "/accounts");
    await page.getByRole("button", { name: "Gateway bearbeiten" }).click();
    await page.getByLabel("Gespeicherten API-Key entfernen").check();
    const save = page.getByRole("button", { name: "Speichern", exact: true });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(controls.calls.filter((call) => call.method === "PATCH").at(-1).body).toEqual({
      name: "Gateway",
      removeApiKey: true,
    });
    await expect(page.locator(".account-card")).toContainText("API-Key fehlt");
  });
}
