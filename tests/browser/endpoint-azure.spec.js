import { openNewSession } from "../helpers/navigation.js";
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./providers-fixture.js";
import { accountDetail, openAccountItem, saveBar } from "../helpers/accounts-browser.js";

// Azure OpenAI lists base models, not deployments, and reports no context size
// (AGENTPIER-393, 409, 410, 413).
test.use({ locale: "en-GB" });

const deploymentUrl =
  "https://contoso.openai.azure.com/openai/deployments/gpt-4o-prod/chat/completions?api-version=2024-10-21";

test("an Azure deployment URL, a failed test and the context size before saving", async ({
  page,
}) => {
  const controls = await fixture(page);
  // The deployment answered with an unknown-model error: no proof of a missing protocol.
  controls.endpointProposal = {
    models: [],
    listed: true,
    protocols: { messages: "skipped", responses: "failed", chatCompletions: "failed" },
    reasons: { responses: "modelNotFound", chatCompletions: "modelNotFound" },
    probeModelId: "gpt-4o-prod",
    warnings: ["azureBaseModels"],
  };
  await page.goto(baseURL + "/connections?section=models");
  await page
    .getByRole("button", { name: "Add provider connection", exact: true })
    .click();
  const dialog = accountDetail(page);
  await dialog.getByLabel("Connection name", { exact: true }).fill("Team Azure");
  await dialog.getByLabel("API provider", { exact: true }).selectOption("endpoint:azure");
  const url = dialog.getByLabel("OpenAI-compatible base URL");
  await url.fill(deploymentUrl);
  await expect(url).toHaveValue("https://contoso.openai.azure.com/openai/v1");
  await expect(dialog.getByText(/Deployment gpt-4o-prod was added/)).toBeVisible();
  const context = dialog.getByLabel("Context gpt-4o-prod", { exact: true });
  await expect(context).toBeVisible();

  await dialog.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(dialog.getByText(/not your deployments/)).toBeVisible();
  // "Automatic" tested the entered deployment.
  const testCall = controls.calls.find(
    (call) => call.path === "/api/provider-connections/test",
  );
  expect(testCall.body.probeModelId).toBe("gpt-4o-prod");
  // Failed protocols stay ticked.
  await expect(dialog.getByRole("checkbox", { name: /Responses/ })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: /Chat Completions/ })).toBeChecked();
  await expect(dialog.getByText(/Enter the context size of this model/)).toBeVisible();
  await dialog
    .locator(".endpoint-protocols")
    .getByRole("button", { name: "Context of gpt-4o-prod", exact: true })
    .click();
  await expect(context).toBeFocused();

  // The first save asks for the context size and points at the field.
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  const save = saveBar(page).getByRole("button", {
    name: "Save connection",
    exact: true,
  });
  await save.click();
  await expect(context).toBeFocused();
  await expect(dialog.locator(".endpoint-models").getByRole("alert")).toContainText(
    "Save again to save without a context size",
  );
  expect(
    controls.calls.filter(
      (call) => call.path === "/api/provider-connections" && call.method === "POST",
    ),
  ).toHaveLength(0);
  await context.fill("128000");
  await save.click();
  await expect(saveBar(page)).toHaveCount(0);
  const created = controls.calls
    .filter((call) => call.path === "/api/provider-connections" && call.method === "POST")
    .at(-1).body;
  expect(created.endpoint).toMatchObject({
    preset: "azure",
    openaiBaseUrl: "https://contoso.openai.azure.com/openai/v1",
    protocols: { messages: false, responses: true, chatCompletions: true },
  });
  expect(created.endpoint.models).toEqual([
    expect.objectContaining({
      modelId: "gpt-4o-prod",
      source: "manual",
      contextTokens: 128000,
    }),
  ]);
});

const azureConnection = (overrides = {}) => ({
  id: "azure-box",
  name: "Team Azure",
  providerId: "endpoint",
  hasSecret: true,
  launchable: true,
  tools: ["claude", "codex", "opencode"],
  endpoint: {
    preset: "azure",
    openaiBaseUrl: "https://contoso.openai.azure.com/openai/v1",
    anthropicBaseUrl: "",
    authHeader: "api-key",
    protocols: { messages: false, responses: true, chatCompletions: true },
    models: [
      {
        modelId: "gpt-4o-prod",
        label: "gpt-4o-prod",
        contextTokens: null,
        outputTokens: null,
        source: "manual",
        contextEdited: true,
      },
    ],
  },
  ...overrides,
});

test("a connection without a usable protocol says so", async ({ page }) => {
  const controls = await fixture(page);
  const connection = azureConnection();
  connection.endpoint.protocols = {
    messages: false,
    responses: false,
    chatCompletions: false,
  };
  controls.state.providerConnections = [connection];
  await page.goto(baseURL + "/connections?section=models");
  const dialog = await openAccountItem(page, "Team Azure");
  await expect(dialog.getByRole("alert")).toContainText(
    "No protocol is ticked, so no CLI can use this connection",
  );
  await dialog.getByRole("checkbox", { name: /Chat Completions/ }).check();
  await expect(dialog.getByText(/No protocol is ticked/)).toHaveCount(0);
});

test("the launcher links a model without context to its field", async ({ page }) => {
  const controls = await fixture(page);
  controls.state.providerConnections = [azureConnection()];
  await page.goto(baseURL + "/");
  await openNewSession(page);
  await page.getByLabel("CLI", { exact: true }).selectOption("codex");
  await page.getByLabel("Connection", { exact: true }).selectOption("provider:azure-box");
  await expect(page.getByText(/1 model needs a context size/)).toBeVisible();
  await page.getByRole("link", { name: "Set the context of gpt-4o-prod" }).click();
  await expect(page).toHaveURL(
    /\/connections\?section=models&item=azure-box&model=gpt-4o-prod/,
  );
  await expect(
    accountDetail(page).getByLabel("Context gpt-4o-prod", { exact: true }),
  ).toBeFocused();
});
