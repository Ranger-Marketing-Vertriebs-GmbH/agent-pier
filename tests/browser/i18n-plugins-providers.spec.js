import { test, expect } from "@playwright/test";
import { fixture as providerFixture } from "./providers-fixture.js";

test.use({ locale: "en-GB" });

test("English Marketplace localizes empty and unavailable catalog guidance and native notices", async ({
  page,
}, testInfo) => {
  const accounts = [
    { id: "local-codex", name: "Local Codex", tool: "codex", kind: "local" },
    { id: "work", name: "Mein eigenes Konto", tool: "codex", kind: "managed" },
  ];
  const inventory = {
    available: true,
    tool: "codex",
    installed: [],
    catalog: [],
    marketplaces: [
      {
        name: "openai-curated-remote",
        builtin: true,
        source: "Nativer Codex-Standardkatalog des ausgewählten Kontos",
        removable: false,
        updatable: false,
      },
    ],
    capabilities: { marketplaces: true, install: true },
    catalogAccounts: accounts,
    catalogAccountId: "local-codex",
    catalogReasonCode: "empty",
    catalogReason: "Für dieses Konto sind keine Standard-Plugins verfügbar.",
    noteCodes: ["restartRequired", "codexActivation"],
    note: "Änderungen gelten für neue CLI-Sitzungen. Aktivierung über /plugins.",
  };
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/state")
      return route.fulfill({
        json: {
          accounts,
          sharedCliExtensions: true,
          sessions: [],
          home: "/fixture",
          tools: [{ id: "codex", name: "Codex", installed: true }],
        },
      });
    if (url.pathname.endsWith("/plugins"))
      return route.fulfill({
        json: {
          ...inventory,
          catalogAccountId: url.searchParams.get("catalogAccountId") || "local-codex",
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto("/plugins");
  await expect(page.getByLabel("Marketplace account", { exact: true })).toHaveValue(
    "local-codex",
  );
  await expect(
    page.getByRole("heading", { name: "Codex default marketplace", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "No default plugins are available for this account. Choose an account signed in to Codex and reload.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.locator(".plugin-topbar")).toContainText(
    "Changes apply to new CLI sessions.",
  );
  await expect(page.locator(".plugin-topbar")).toContainText(
    "/plugins provides native activation.",
  );
  await expect(
    page
      .getByLabel("Marketplace account")
      .getByRole("option", { name: "Mein eigenes Konto" }),
  ).toHaveCount(1);
  await expect(page.getByText(inventory.catalogReason, { exact: true })).toHaveCount(0);
  await expect(page.getByText(inventory.note, { exact: true })).toHaveCount(0);
  inventory.catalogReasonCode = "unavailable";
  inventory.catalogReason =
    "Der Standardkatalog des ausgewählten Kontos konnte nicht geladen werden.";
  await page.getByLabel("Marketplace account", { exact: true }).selectOption("work");
  await expect(
    page.getByText(
      "The default catalog for the selected account could not be loaded. Local plugins remain available.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("english-marketplace.png"),
    fullPage: true,
  });
});

test("English provider picker supports translated search, empty results and keyboard selection", async ({
  page,
}, testInfo) => {
  const controls = await providerFixture(page, {
    account: {
      id: "legacy-gateway",
      name: "Gateway account",
      tool: "opencode",
      kind: "managed",
      hasSecret: false,
      provider: { id: "zai-coding-plan", modelId: "legacy-model" },
    },
  });
  await page.goto("/accounts");
  await page.getByRole("button", { name: "Edit Gateway account", exact: true }).click();
  await page.getByLabel("API provider", { exact: true }).selectOption("openrouter");
  const model = page.getByLabel("Provider model", { exact: true });
  await expect(model).toBeEnabled();
  await model.click();
  const search = page.getByRole("combobox", { name: "Search models", exact: true });
  await search.fill("not-a-real-model");
  await expect(
    page.getByText("No matching models found for this CLI.", { exact: true }),
  ).toBeVisible();
  await search.fill("z-ai/glm");
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(model).toHaveValue("z-ai/glm-5.3");
  await expect(page.getByText("Reported context window", { exact: true })).toBeVisible();
  await expect(page.getByText("Bundled catalog", { exact: true }).last()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh model catalog", exact: true }).last(),
  ).toBeVisible();
  expect(controls.calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
  await page.screenshot({
    path: testInfo.outputPath("english-provider-model.png"),
    fullPage: true,
  });
});
