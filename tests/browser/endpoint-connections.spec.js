import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./providers-fixture.js";

test.use({ locale: "en-GB" });

test("create a keyless Ollama connection, confirm context and launch with it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const controls = await fixture(page);
  controls.state.accounts = ["codex", "claude", "opencode"].map((tool) => ({
    id: `local-${tool}`,
    name: `Native ${tool}`,
    tool,
    kind: "local",
  }));
  await page.goto(baseURL + "/accounts");
  await page
    .getByRole("button", { name: "Add provider connection", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Connection name", { exact: true }).fill("GPU box");
  await dialog.getByLabel("API provider", { exact: true }).selectOption("endpoint");
  await expect(dialog.getByLabel("OpenAI-compatible base URL")).toHaveValue(
    "http://127.0.0.1:11434/v1",
  );
  await dialog.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(dialog.getByText("Not supported · Endpoint not found")).toBeVisible();
  await expect(dialog.getByText(/does not report the loaded context/)).toBeVisible();
  const testCall = controls.calls.find(
    (call) => call.path === "/api/provider-connections/test",
  );
  expect(testCall.body).not.toHaveProperty("apiKey");
  const context = dialog.getByLabel("Context llama3:8b", { exact: true });
  await expect(context).toHaveAttribute("placeholder", "Model maximum: 131072");
  await context.fill("8192");
  const overflow = await page.evaluate(() => {
    const scroller = document.querySelector(".endpoint-model-scroll");
    const row = document.querySelector(".endpoint-models tbody tr");
    const id = row.querySelector(".endpoint-model-id");
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dialog: [...document.querySelectorAll("[role=dialog], [role=dialog] *")].filter(
        (element) => element.getBoundingClientRect().right > window.innerWidth + 1,
      ).length,
      scroller: scroller.scrollWidth - scroller.clientWidth,
      idHeight: id.getBoundingClientRect().height,
    };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.dialog).toBe(0);
  expect(overflow.scroller).toBeLessThanOrEqual(0);
  expect(overflow.idHeight).toBeLessThan(40);
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const created = controls.calls
    .filter((call) => call.path === "/api/provider-connections" && call.method === "POST")
    .at(-1).body;
  expect(created.apiKey).toBeUndefined();
  expect(created.endpoint.protocols).toEqual({
    messages: true,
    responses: false,
    chatCompletions: true,
  });
  expect(created.endpoint.models[1]).toMatchObject({
    modelId: "llama3:8b",
    contextTokens: 8192,
    contextEdited: true,
  });
  await expect(page.getByText("No API key required")).toBeVisible();

  await page.goto(baseURL + "/");
  await page
    .locator(".mobile-header")
    .getByRole("button", { name: "New session", exact: true })
    .click();
  await page.getByLabel("CLI", { exact: true }).selectOption("codex");
  const access = page.getByLabel("Connection", { exact: true });
  await expect(access.locator('option[value="provider:connection-one"]')).toHaveCount(0);
  await page.getByLabel("CLI", { exact: true }).selectOption("claude");
  await access.selectOption("provider:connection-one");
  await expect(
    access.locator('option[value="provider:connection-one"]'),
  ).not.toContainText("API key missing");
  const model = page.getByLabel("Provider model", { exact: true });
  await expect(model.locator("option")).toContainText(["qwen3:8b", "llama3:8b"]);
  await model.selectOption("llama3:8b");
  await page.getByLabel("Working directory", { exact: true }).fill("/fixture");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  const body = controls.calls.find(
    (call) => call.path === "/api/sessions" && call.method === "POST",
  ).body;
  expect(body).toMatchObject({
    tool: "claude",
    providerConnectionId: "connection-one",
    providerModelId: "llama3:8b",
  });
});

test("changing the address of a keyed endpoint requires the key again", async ({
  page,
}) => {
  const controls = await fixture(page);
  controls.state.providerConnections = [
    {
      id: "keyed",
      name: "Gateway box",
      providerId: "endpoint",
      hasSecret: true,
      launchable: true,
      tools: ["claude", "opencode"],
      endpoint: {
        openaiBaseUrl: "http://gpu.example:11434/v1",
        anthropicBaseUrl: "",
        authHeader: "",
        protocols: { messages: false, responses: false, chatCompletions: true },
        models: [
          {
            modelId: "qwen3:8b",
            label: "qwen3:8b",
            contextTokens: 40960,
            outputTokens: null,
            source: "detected",
            contextEdited: false,
          },
        ],
      },
    },
  ];
  await page.goto(baseURL + "/accounts");
  await page.getByRole("button", { name: "Edit Gateway box", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const save = dialog.getByRole("button", { name: "Save connection", exact: true });
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(save).toBeEnabled();
  await dialog
    .getByLabel("OpenAI-compatible base URL")
    .fill("http://other.example:11434/v1");
  await expect(dialog.getByRole("alert")).toContainText("Enter the API key again");
  await expect(save).toBeDisabled();
});

test("changing the address after a test discards the stale test result", async ({
  page,
}) => {
  const controls = await fixture(page);
  await page.goto(baseURL + "/accounts");
  await page
    .getByRole("button", { name: "Add provider connection", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Connection name", { exact: true }).fill("GPU box");
  await dialog.getByLabel("API provider", { exact: true }).selectOption("endpoint");
  await expect(
    dialog.getByText("For Azure OpenAI choose one of your deployments as test model."),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Test connection", exact: true }).click();
  const status = dialog.getByText("Not supported · Endpoint not found");
  await expect(status).toBeVisible();
  await dialog
    .getByLabel("OpenAI-compatible base URL")
    .fill("http://gpu.example:11434/v1");
  await expect(status).toHaveCount(0);
  await expect(dialog.getByText(/does not report the loaded context/)).toHaveCount(0);
  await dialog.getByLabel("Context llama3:8b", { exact: true }).fill("8192");
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const created = controls.calls
    .filter((call) => call.path === "/api/provider-connections" && call.method === "POST")
    .at(-1).body;
  expect(created.endpoint.openaiBaseUrl).toBe("http://gpu.example:11434/v1");
  expect(created.endpoint.lastTest).toBeNull();
  // Protocol choices from the test stay as the user left them.
  expect(created.endpoint.protocols).toEqual({
    messages: true,
    responses: false,
    chatCompletions: true,
  });
});
