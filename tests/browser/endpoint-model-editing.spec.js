import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./providers-fixture.js";

test.use({ locale: "en-GB" });

async function openEndpointDialog(page) {
  await page.goto(baseURL + "/accounts");
  await page
    .getByRole("button", { name: "Add provider connection", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Connection name", { exact: true }).fill("GPU box");
  await dialog.getByLabel("API provider", { exact: true }).selectOption("endpoint");
  return dialog;
}

test("Enter in the add-model field adds the model and keeps the dialog open", async ({
  page,
}) => {
  const controls = await fixture(page);
  const dialog = await openEndpointDialog(page);
  const field = dialog.getByLabel("Model ID", { exact: true });
  await field.fill("gpt-4o-prod");
  await field.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Context gpt-4o-prod", { exact: true })).toBeVisible();
  await expect(field).toHaveValue("");
  await field.fill("not valid");
  await field.press("Enter");
  await expect(dialog).toBeVisible();
  expect(
    controls.calls.filter(
      (call) => call.path === "/api/provider-connections" && call.method === "POST",
    ),
  ).toHaveLength(0);
});

test("invalid model rows are marked and block saving", async ({ page }) => {
  await fixture(page);
  const dialog = await openEndpointDialog(page);
  const add = dialog.getByRole("button", { name: "Add model", exact: true });
  const save = dialog.getByRole("button", { name: "Save connection", exact: true });
  const field = dialog.getByLabel("Model ID", { exact: true });
  await field.fill("/models/qwen.gguf");
  await expect(add).toBeDisabled();
  await field.fill("qwen3");
  await add.click();
  await dialog.getByLabel("Context qwen3", { exact: true }).fill("4096");
  await dialog.getByLabel("Max output qwen3", { exact: true }).fill("8192");
  await expect(dialog.getByText("Max output must not exceed the context.")).toBeVisible();
  await expect(save).toBeDisabled();
  await dialog.getByLabel("Max output qwen3", { exact: true }).fill("2048");
  await expect(save).toBeEnabled();
});

test("the test model falls back to Automatic when its model is removed", async ({
  page,
}) => {
  const controls = await fixture(page);
  const dialog = await openEndpointDialog(page);
  await dialog.getByLabel("Model ID", { exact: true }).fill("m1");
  await dialog.getByRole("button", { name: "Add model", exact: true }).click();
  await dialog.getByLabel("Test model", { exact: true }).selectOption("m1");
  await dialog.getByRole("button", { name: "Remove m1", exact: true }).click();
  await expect(dialog.getByLabel("Test model", { exact: true })).toHaveValue("");
  await dialog.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(dialog.getByText("Not supported · Endpoint not found")).toBeVisible();
  const call = controls.calls.find(
    (item) => item.path === "/api/provider-connections/test",
  );
  expect(call.body).not.toHaveProperty("probeModelId");
});

test("an Ollama address change moves the Anthropic URL along", async ({ page }) => {
  await fixture(page);
  const dialog = await openEndpointDialog(page);
  const anthropic = dialog.getByLabel("Anthropic-compatible base URL");
  await dialog.getByLabel("OpenAI-compatible base URL").fill("http://gpu-box:11434/v1");
  await dialog.getByText("Advanced", { exact: true }).click();
  await expect(anthropic).toHaveValue("http://gpu-box:11434");
  await anthropic.fill("http://other:1");
  await dialog.getByLabel("OpenAI-compatible base URL").fill("http://gpu-box:9/v1");
  await expect(anthropic).toHaveValue("http://other:1");
});

test("endpoint pickers hide the catalog refresh and flag models without context", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const controls = await fixture(page);
  const manual = { source: "manual", contextEdited: true, outputTokens: null };
  controls.state.accounts = [
    { id: "local-claude", name: "Native claude", tool: "claude", kind: "local" },
  ];
  controls.state.providerConnections = [
    {
      id: "ctx",
      name: "Ctx box",
      providerId: "endpoint",
      hasSecret: false,
      launchable: true,
      tools: ["claude"],
      endpoint: {
        openaiBaseUrl: "http://gpu.example:11434/v1",
        anthropicBaseUrl: "http://gpu.example:11434",
        authHeader: "",
        protocols: { messages: true, responses: false, chatCompletions: true },
        models: [
          { ...manual, modelId: "ready:1", label: "ready:1", contextTokens: 8192 },
          { ...manual, modelId: "later:1", label: "later:1", contextTokens: null },
        ],
      },
    },
  ];
  await page.goto(baseURL + "/");
  await page
    .locator(".mobile-header")
    .getByRole("button", { name: "New session", exact: true })
    .click();
  await page.getByLabel("CLI", { exact: true }).selectOption("claude");
  await page.getByLabel("Connection", { exact: true }).selectOption("provider:ctx");
  const model = page.getByLabel("Provider model", { exact: true });
  await expect(model.locator("option")).toContainText(["ready:1", "later:1"]);
  await expect(model.locator('option[value="later:1"]')).toHaveAttribute("disabled", "");
  await expect(model.locator('option[value="ready:1"]')).not.toHaveAttribute(
    "disabled",
    "",
  );
  await expect(page.getByText(/1 model needs a context size/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh model catalog", exact: true }),
  ).toHaveCount(0);
});

test.describe("German UI", () => {
  test.use({ locale: "de-DE" });
  test("the provider dropdown shows the translated endpoint name", async ({ page }) => {
    await fixture(page);
    await page.goto(baseURL + "/accounts");
    await page.getByRole("button", { name: /Provider-Zugang hinzufügen/ }).click();
    await expect(
      page
        .getByRole("dialog")
        .getByLabel("API-Anbieter")
        .locator("option", { hasText: "Eigener Endpunkt" }),
    ).toHaveCount(1);
  });
});
