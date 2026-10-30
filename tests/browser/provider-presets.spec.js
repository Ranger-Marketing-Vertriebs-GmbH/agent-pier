import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./providers-fixture.js";
import {
  accountDetail,
  accountRow,
  openAccountItem,
} from "../helpers/accounts-browser.js";

// Ollama, llama.cpp and Azure OpenAI are their own API provider entries (AGENTPIER-256).
test.use({ locale: "en-GB" });

const presets = [
  {
    label: "Ollama",
    value: "endpoint:ollama",
    url: "http://127.0.0.1:11434/v1",
    anthropic: "http://127.0.0.1:11434",
    header: "",
    protocols: { messages: true, responses: true, chatCompletions: true },
  },
  {
    label: "llama.cpp",
    value: "endpoint:llamacpp",
    url: "http://127.0.0.1:8080/v1",
    anthropic: "http://127.0.0.1:8080",
    header: "",
    protocols: { messages: false, responses: false, chatCompletions: true },
  },
  {
    label: "Azure OpenAI",
    value: "endpoint:azure",
    url: "",
    anthropic: "",
    header: "api-key",
    protocols: { messages: false, responses: true, chatCompletions: true },
  },
];

async function openNew(page) {
  await page.goto(baseURL + "/connections?section=models");
  await page
    .getByRole("button", { name: "Add provider connection", exact: true })
    .click();
  return accountDetail(page);
}

test("the model access description names local models", async ({ page }) => {
  await fixture(page);
  await page.goto(baseURL + "/connections?section=models");
  await expect(
    page.getByText(/No shared provider connections yet\. .*Ollama and llama\.cpp/),
  ).toBeVisible();
});

test("the API provider lists each preset, which opens the form with its defaults", async ({
  page,
}) => {
  const controls = await fixture(page);
  const dialog = await openNew(page);
  const provider = dialog.getByLabel("API provider", { exact: true });
  await expect(provider.locator("option")).toHaveText([
    "OpenRouter",
    "Z.ai API",
    "Z.ai Coding Plan",
    "Ollama",
    "llama.cpp",
    "Azure OpenAI",
    "Custom endpoint",
  ]);
  const server = dialog.getByLabel("Server type", { exact: true });
  const url = dialog.getByLabel("OpenAI-compatible base URL");
  for (const preset of presets) {
    await provider.selectOption({ label: preset.label });
    await expect(provider).toHaveValue(preset.value);
    await expect(server).toHaveValue(preset.value.slice("endpoint:".length));
    await expect(url).toHaveValue(preset.url);
    await expect(dialog.getByLabel("Anthropic-compatible base URL")).toHaveValue(
      preset.anthropic,
    );
    await expect(dialog.getByLabel("Auth header name")).toHaveValue(preset.header);
  }
  // Azure: the URL pattern and the deployment hints.
  await expect(url).toHaveAttribute(
    "placeholder",
    "https://<resource>.openai.azure.com/openai/v1",
  );
  await expect(dialog.getByText(/Replace <resource> with the name/)).toBeVisible();
  await expect(
    dialog.getByText("For Azure OpenAI choose one of your deployments as test model."),
  ).toBeVisible();
  await expect(
    dialog.getByText("Azure OpenAI: enter your deployment names as model IDs."),
  ).toBeVisible();

  // Custom endpoint stays for every other compatible server.
  await provider.selectOption({ label: "Custom endpoint" });
  await expect(server).toHaveValue("custom");
  await expect(url).toHaveValue("");
  await expect(dialog.getByText(/For LM Studio, vLLM, LiteLLM/)).toBeVisible();
  await expect(dialog.getByText(/For Azure OpenAI choose one/)).toHaveCount(0);
  // Changing the server type in the form moves the provider entry along.
  await server.selectOption("llamacpp");
  await expect(provider).toHaveValue("endpoint:llamacpp");

  // Each preset is saved as an endpoint connection with its protocols.
  for (const preset of presets) {
    await provider.selectOption(preset.value);
    await dialog.getByLabel("Connection name", { exact: true }).fill(preset.label);
    if (!preset.url) await url.fill("https://contoso.openai.azure.com/openai/v1");
    await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
    await expect
      .poll(() => controls.state.providerConnections.map((item) => item.name))
      .toContain(preset.label);
    const created = controls.calls
      .filter(
        (call) => call.path === "/api/provider-connections" && call.method === "POST",
      )
      .at(-1).body;
    expect(created.providerId).toBe("endpoint");
    expect(created.endpoint.preset).toBe(preset.value.slice("endpoint:".length));
    expect(created.endpoint.protocols).toEqual(preset.protocols);
    expect(created.endpoint.authHeader).toBe(preset.header || null);
    controls.state.providerConnections = [];
    await openNew(page);
  }
});

test("stored endpoints show their preset, or Custom endpoint without one", async ({
  page,
}) => {
  const controls = await fixture(page);
  const endpoint = (preset) => ({
    ...(preset ? { preset } : {}),
    openaiBaseUrl: "http://gpu.example:11434/v1",
    anthropicBaseUrl: null,
    authHeader: null,
    protocols: { messages: false, responses: false, chatCompletions: true },
    models: [],
  });
  controls.state.providerConnections = [
    ["azure-box", "Team Azure", "azure"],
    ["llama-box", "GPU box", "llamacpp"],
    ["gateway", "Gateway", "custom"],
    ["legacy", "Old endpoint", undefined],
  ].map(([id, name, preset]) => ({
    id,
    name,
    providerId: "endpoint",
    hasSecret: false,
    launchable: true,
    tools: ["claude", "opencode"],
    endpoint: endpoint(preset),
  }));
  await page.goto(baseURL + "/connections?section=models");
  const sub = (name) => accountRow(page, name);
  await expect(sub("Team Azure")).toContainText("Azure OpenAI");
  await expect(sub("GPU box")).toContainText("llama.cpp");
  await expect(sub("Gateway")).toContainText("Custom endpoint");
  await expect(sub("Old endpoint")).toContainText("Custom endpoint");
  const dialog = await openAccountItem(page, "GPU box");
  await expect(dialog.getByLabel("API provider", { exact: true })).toHaveValue(
    "endpoint:llamacpp",
  );
});
