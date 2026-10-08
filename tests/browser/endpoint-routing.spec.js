// tests/browser/endpoint-routing.spec.js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./providers-fixture.js";

test.use({ locale: "en-GB" });

async function openNewEndpoint(page, preset = "llamacpp") {
  const controls = await fixture(page);
  await page.goto(baseURL + "/accounts");
  await page
    .getByRole("button", { name: "Add provider connection", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Connection name", { exact: true }).fill("GPU box");
  await dialog.getByLabel("API provider", { exact: true }).selectOption("endpoint");
  await dialog.getByLabel("Server type", { exact: true }).selectOption(preset);
  const routing = dialog.getByRole("group", { name: "CLIs and routes", exact: true });
  const uses = (text) => routing.getByText(`Uses: ${text}`, { exact: true });
  const select = (cli) => routing.getByLabel(`Route for ${cli}`, { exact: true });
  return { controls, dialog, routing, uses, select };
}

test("routes resolve live and explain unavailable choices", async ({ page }) => {
  const { controls, dialog, routing, uses, select } = await openNewEndpoint(page);
  // llama.cpp preset: only Chat Completions is enabled.
  await expect(uses("via adapter · Chat Completions")).toHaveCount(2);
  await expect(uses("native")).toHaveCount(1);
  const claude = select("Claude Code");
  await expect(claude).toHaveAccessibleDescription(
    "Uses: via adapter · Chat Completions",
  );
  await expect(claude.locator('option[value="native"]')).toBeDisabled();
  await expect(claude.locator('option[value="native"]')).toHaveText(
    "Native (Messages) – not available: protocol not enabled",
  );
  await expect(claude.locator('option[value="adapter:responses"]')).toBeDisabled();
  // Protocol labels name only the native pairing; Chat Completions has none.
  for (const name of [
    "Anthropic Messages · native for Claude Code",
    "OpenAI Responses · native for Codex",
    "OpenAI Chat Completions",
  ])
    await expect(dialog.getByRole("checkbox", { name, exact: true })).toBeVisible();
  const responses = dialog.getByRole("checkbox", { name: /OpenAI Responses/ });
  await responses.check();
  await claude.selectOption("adapter:responses");
  await expect(uses("via adapter · Responses")).toBeVisible();
  if (process.env.CAPTURE_ADAPTER_SCREENSHOTS) {
    await dialog.getByText("Adapter options", { exact: true }).scrollIntoViewIfNeeded();
    await dialog.screenshot({
      path: "docs/screenshots/endpoint-routing-desktop.png",
      animations: "disabled",
    });
  }
  // Review Focus 2: the explicit choice survives when its protocol is switched off again.
  await responses.uncheck();
  await expect(claude).toHaveValue("adapter:responses");
  await expect(
    routing.getByText("Not available: protocol not enabled", { exact: true }),
  ).toBeVisible();
  await expect(uses("not offered")).toBeVisible();
  await expect(claude).toHaveAccessibleDescription(
    "Uses: not offered Not available: protocol not enabled",
  );
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const created = controls.calls
    .filter((call) => call.path === "/api/provider-connections" && call.method === "POST")
    .at(-1).body;
  expect(created.endpoint.protocols.responses).toBe(false);
  expect(created.endpoint.routing).toEqual({
    claude: "adapter:responses",
    codex: "auto",
    opencode: "auto",
  });
});

test("Ollama routes switch from native to the adapter and off", async ({ page }) => {
  const { dialog, uses, select } = await openNewEndpoint(page, "ollama");
  await expect(uses("native")).toHaveCount(3);
  await dialog.getByRole("checkbox", { name: /OpenAI Responses/ }).uncheck();
  await dialog.getByRole("checkbox", { name: /OpenAI Chat Completions/ }).uncheck();
  // Messages only: Codex goes through the adapter, OpenCode uses its Messages SDK.
  await expect(select("Codex")).toHaveAccessibleDescription(
    "Uses: via adapter · Messages",
  );
  await expect(select("OpenCode")).toHaveAccessibleDescription("Uses: Messages");
  await expect(select("OpenCode").locator('option[value="responses"]')).toHaveText(
    "Responses – not available: protocol not enabled",
  );
  await select("OpenCode").selectOption("off");
  await expect(select("OpenCode")).toHaveAccessibleDescription("Uses: not offered");
});

test("a route can be chosen with the keyboard, skipping unavailable ones", async ({
  page,
}) => {
  const { select } = await openNewEndpoint(page);
  const claude = select("Claude Code");
  await claude.focus();
  await claude.press("ArrowDown");
  await claude.press("ArrowDown");
  await claude.press("Enter");
  await expect(claude).toHaveValue("adapter:chatCompletions");
});

test("missing base URLs are named as the reason", async ({ page }) => {
  const { uses, select } = await openNewEndpoint(page, "custom");
  await expect(uses("not offered")).toHaveCount(3);
  await expect(select("Claude Code").locator('option[value="native"]')).toHaveText(
    "Native (Messages) – not available: Anthropic-compatible base URL missing",
  );
  await expect(
    select("Codex").locator('option[value="adapter:chatCompletions"]'),
  ).toHaveText(
    "Via adapter (Chat Completions) – not available: OpenAI-compatible base URL missing",
  );
});

test("test proposals fill adapter options that stay editable", async ({ page }) => {
  const { controls, dialog } = await openNewEndpoint(page);
  controls.endpointProposal = {
    ...controls.endpointProposal,
    protocols: {
      messages: "unsupported",
      responses: "unsupported",
      chatCompletions: "ok",
    },
    reasons: { messages: "notFound", responses: "notFound" },
    capabilities: {
      chatCompletions: { reasoningEffort: false, systemMessages: "inline" },
    },
    warnings: [],
  };
  await dialog.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(dialog.locator(".endpoint-adapter-status")).toHaveText(
    "Adapter options updated with the test suggestions.",
  );
  await dialog.getByText("Adapter options", { exact: true }).click();
  const options = dialog.getByRole("group", {
    name: "Adapter options · Chat Completions",
    exact: true,
  });
  const effort = options.getByRole("checkbox", {
    name: "Send reasoning effort",
    exact: true,
  });
  await expect(effort).not.toBeChecked();
  await expect(effort).toHaveAccessibleDescription("suggested by the test");
  await expect(options.getByText("suggested by the test")).toHaveCount(2);
  await effort.check();
  await expect(effort).toHaveAccessibleDescription("changed by you");
  if (process.env.CAPTURE_ADAPTER_SCREENSHOTS) {
    await options.screenshot({
      path: "docs/screenshots/endpoint-adapter-options.png",
      animations: "disabled",
    });
  }
  await expect(
    options.getByLabel("Keep as system messages", { exact: true }),
  ).toBeChecked();
  await dialog
    .getByRole("checkbox", { name: "Read <think> tags as reasoning", exact: true })
    .check();
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const created = controls.calls
    .filter((call) => call.path === "/api/provider-connections" && call.method === "POST")
    .at(-1).body;
  expect(created.endpoint.adapterCapabilities).toEqual({
    chatCompletions: { reasoningEffort: true, systemMessages: "inline" },
  });
  expect(created.endpoint.thinkTagExtraction).toBe(true);
});

test("image support per model is saved as a tri-state", async ({ page }) => {
  const { controls, dialog } = await openNewEndpoint(page);
  await dialog.getByRole("button", { name: "Test connection", exact: true }).click();
  const images = dialog.getByLabel("Images qwen3:8b", { exact: true });
  await expect(images).toHaveValue("");
  await images.selectOption("no");
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const created = controls.calls
    .filter((call) => call.path === "/api/provider-connections" && call.method === "POST")
    .at(-1).body;
  expect(created.endpoint.models.find((m) => m.modelId === "qwen3:8b").images).toBe(
    false,
  );
  expect(
    created.endpoint.models.find((m) => m.modelId === "llama3:8b").images,
  ).toBeNull();
});

test.describe("narrow screen", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("the routing section fits without horizontal overflow", async ({ page }) => {
    const { routing } = await openNewEndpoint(page);
    await routing.scrollIntoViewIfNeeded();
    await expect(routing).toBeVisible();
    const overflow = await routing.evaluate((element) => ({
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dialog:
        element.closest("dialog").scrollWidth - element.closest("dialog").clientWidth,
      routing: element.scrollWidth - element.clientWidth,
    }));
    expect(overflow).toEqual({ page: 0, dialog: 0, routing: 0 });
  });
  test("the adapter options fit without horizontal overflow", async ({ page }) => {
    const { dialog } = await openNewEndpoint(page);
    await dialog.getByText("Adapter options", { exact: true }).click();
    const options = dialog.getByRole("group", {
      name: "Adapter options · Chat Completions",
      exact: true,
    });
    await options.scrollIntoViewIfNeeded();
    await expect(options).toBeVisible();
    const overflow = await options.evaluate((element) => ({
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dialog:
        element.closest("dialog").scrollWidth - element.closest("dialog").clientWidth,
      options: element.scrollWidth - element.clientWidth,
    }));
    expect(overflow).toEqual({ page: 0, dialog: 0, options: 0 });
  });
});

test.describe("German UI", () => {
  test.use({ locale: "de-DE" });
  test("the routing section is translated", async ({ page }) => {
    await fixture(page);
    await page.goto(baseURL + "/accounts");
    await page.getByRole("button", { name: /Provider-Zugang hinzufügen/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("API-Anbieter", { exact: true }).selectOption("endpoint");
    await dialog.getByLabel("Server-Typ", { exact: true }).selectOption("llamacpp");
    const routing = dialog.getByRole("group", { name: "CLIs und Routen", exact: true });
    const claude = routing.getByLabel("Route für Claude Code", { exact: true });
    await expect(claude).toHaveAccessibleDescription(
      "Verwendet: über Adapter · Chat Completions",
    );
    await expect(claude.locator('option[value="native"]')).toHaveText(
      "Nativ (Messages) – nicht verfügbar: Protokoll nicht aktiviert",
    );
  });
});
