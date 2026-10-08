// tests/browser/endpoint-adapter-options.spec.js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./providers-fixture.js";

test.use({ locale: "en-GB" });

const CHAT_ONLY = {
  protocols: { messages: "unsupported", responses: "unsupported", chatCompletions: "ok" },
  reasons: { messages: "notFound", responses: "notFound" },
  warnings: [],
};
const ALL_OK = {
  protocols: { messages: "ok", responses: "ok", chatCompletions: "ok" },
  reasons: {},
  warnings: [],
};
const ENGLISH = {
  add: "Add provider connection",
  provider: "API provider",
  server: "Server type",
  test: "Test connection",
};
const GERMAN = {
  add: "Provider-Zugang hinzufügen",
  provider: "API-Anbieter",
  server: "Server-Typ",
  test: "Verbindung testen",
};
const APPLIED = "Adapter options updated with the test suggestions.";

async function openEndpoint(page, { preset = "llamacpp", labels = ENGLISH } = {}) {
  const controls = await fixture(page);
  await page.goto(baseURL + "/accounts");
  await page.getByRole("button", { name: labels.add, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(labels.provider, { exact: true }).selectOption("endpoint");
  await dialog.getByLabel(labels.server, { exact: true }).selectOption(preset);
  const status = dialog.locator(".endpoint-adapter-status");
  const runTest = async (capabilities, protocols = CHAT_ONLY) => {
    controls.endpointProposal = {
      ...controls.endpointProposal,
      ...protocols,
      capabilities,
    };
    await dialog.getByRole("button", { name: labels.test, exact: true }).click();
  };
  return { controls, dialog, status, runTest };
}

async function savedEndpoint(dialog, controls) {
  await dialog.getByLabel("Connection name", { exact: true }).fill("GPU box");
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  return controls.calls
    .filter((call) => call.path === "/api/provider-connections" && call.method === "POST")
    .at(-1).body.endpoint;
}

async function openChatOptions(dialog, title = "Adapter options") {
  await dialog.getByText(title, { exact: true }).click();
  return dialog.getByRole("group", { name: `${title} · Chat Completions`, exact: true });
}

test("a re-test keeps options the user changed and refreshes the others", async ({
  page,
}) => {
  const { controls, dialog, status, runTest } = await openEndpoint(page);
  await runTest({
    chatCompletions: { reasoningEffort: false, systemMessages: "inline" },
  });
  await expect(status).toHaveText(APPLIED);
  const options = await openChatOptions(dialog);
  const effort = options.getByRole("checkbox", {
    name: "Send reasoning effort",
    exact: true,
  });
  const system = options.getByRole("group", {
    name: "System messages in the middle of a conversation",
    exact: true,
  });
  await effort.check();
  await expect(effort).toHaveAccessibleDescription("changed by you");
  await expect(system).toHaveAccessibleDescription("suggested by the test");
  await runTest({ chatCompletions: { reasoningEffort: false, systemMessages: "merge" } });
  await expect(status).toHaveText(`${APPLIED} Options you changed keep your value.`);
  await expect(
    system.getByLabel("Merge into the next user message", { exact: true }),
  ).toBeChecked();
  await expect(system).toHaveAccessibleDescription("suggested by the test");
  await expect(effort).toBeChecked();
  await expect(effort).toHaveAccessibleDescription("changed by you");
  const endpoint = await savedEndpoint(dialog, controls);
  expect(endpoint.adapterCapabilities).toEqual({
    chatCompletions: { reasoningEffort: true, systemMessages: "merge" },
  });
  expect(endpoint).not.toHaveProperty("capabilityEdits");
});

test("markers under radio groups align with the checkbox markers", async ({ page }) => {
  const { dialog } = await openEndpoint(page);
  const options = await openChatOptions(dialog);
  const layout = await options.evaluate((group) => {
    const box = (selector) => group.querySelector(selector).getBoundingClientRect();
    const size = (selector) => getComputedStyle(group.querySelector(selector)).fontSize;
    return {
      checkboxMarker: box(".endpoint-capability > .endpoint-capability-marker").left,
      choiceMarker: box(".endpoint-capability-choice > .endpoint-capability-marker").left,
      checkboxLabel: size(".endpoint-capability .provider-check span"),
      choiceLegend: size(".endpoint-capability-choice > legend"),
    };
  });
  expect(layout.choiceMarker).toBe(layout.checkboxMarker);
  expect(layout.choiceLegend).toBe(layout.checkboxLabel);
});

test("a re-test without edits takes the new suggestions", async ({ page }) => {
  const { dialog, status, runTest } = await openEndpoint(page);
  await runTest({ chatCompletions: { streamUsage: false } });
  await expect(status).toHaveText(APPLIED);
  const options = await openChatOptions(dialog);
  const usage = options.getByRole("checkbox", {
    name: "Request token usage in the stream",
    exact: true,
  });
  await expect(usage).not.toBeChecked();
  await runTest({ chatCompletions: { streamUsage: true } });
  await expect(usage).toBeChecked();
  await expect(usage).toHaveAccessibleDescription("suggested by the test");
  await expect(status).toHaveText(APPLIED);
});

test("restoring defaults clears suggestions and edits of one protocol", async ({
  page,
}) => {
  const { controls, dialog, status, runTest } = await openEndpoint(page);
  await runTest({
    chatCompletions: { streamUsage: false, maxTokensField: "max_completion_tokens" },
  });
  await expect(status).toHaveText(APPLIED);
  const options = await openChatOptions(dialog);
  const effort = options.getByRole("checkbox", {
    name: "Send reasoning effort",
    exact: true,
  });
  await effort.check();
  await options
    .getByRole("button", { name: "Restore defaults for Chat Completions", exact: true })
    .click();
  await expect(status).toHaveText("Defaults restored for Chat Completions.");
  await expect(effort).not.toBeChecked();
  await expect(effort).toHaveAccessibleDescription("default");
  await expect(
    options.getByRole("checkbox", {
      name: "Request token usage in the stream",
      exact: true,
    }),
  ).toBeChecked();
  await expect(options.getByLabel("max_tokens", { exact: true })).toBeChecked();
  await expect(options.getByText("default", { exact: true })).toHaveCount(7);
  const endpoint = await savedEndpoint(dialog, controls);
  expect(endpoint.adapterCapabilities).toEqual({});
});

test("restoring defaults keeps its announcement while another protocol has suggestions", async ({
  page,
}) => {
  const { dialog, status, runTest } = await openEndpoint(page, { preset: "ollama" });
  await runTest(
    { chatCompletions: { streamUsage: false }, messages: { promptCache: false } },
    ALL_OK,
  );
  await dialog
    .getByLabel("Route for Claude Code", { exact: true })
    .selectOption("adapter:chatCompletions");
  await dialog
    .getByLabel("Route for Codex", { exact: true })
    .selectOption("adapter:messages");
  const options = await openChatOptions(dialog);
  await options
    .getByRole("button", { name: "Restore defaults for Chat Completions", exact: true })
    .click();
  await expect(status).toHaveText("Defaults restored for Chat Completions.");
  await page.waitForTimeout(200);
  await expect(status).toHaveText("Defaults restored for Chat Completions.");
});

test("without an adapter route, suggestions are not saved and <think> is inactive", async ({
  page,
}) => {
  const { controls, dialog, status, runTest } = await openEndpoint(page, {
    preset: "ollama",
  });
  await runTest({ chatCompletions: { reasoningEffort: true } }, ALL_OK);
  await expect(dialog.locator('small[data-status="ok"]')).toHaveCount(3);
  await expect(status).toHaveText("");
  await dialog.getByText("Adapter options", { exact: true }).click();
  await expect(
    dialog.getByText("No CLI uses the protocol adapter with these settings.", {
      exact: true,
    }),
  ).toBeVisible();
  const think = dialog.getByRole("checkbox", {
    name: "Read <think> tags as reasoning",
    exact: true,
  });
  await expect(think).toBeDisabled();
  await expect(think).toHaveAccessibleDescription(
    "Only for adapter routes over Chat Completions, for models that write their reasoning into the answer text. Inactive: no CLI uses an adapter route over Chat Completions with these settings.",
  );
  const endpoint = await savedEndpoint(dialog, controls);
  expect(endpoint.adapterCapabilities).toEqual({});
});

test.describe("German UI", () => {
  test.use({ locale: "de-DE" });
  test("adapter options and markers are translated", async ({ page }) => {
    const { dialog, status, runTest } = await openEndpoint(page, { labels: GERMAN });
    await runTest({ chatCompletions: { reasoningEffort: false } });
    await expect(status).toHaveText(
      "Adapter-Optionen mit den Testvorschlägen aktualisiert.",
    );
    const options = await openChatOptions(dialog, "Adapter-Optionen");
    const effort = options.getByRole("checkbox", {
      name: "Reasoning-Stufe senden",
      exact: true,
    });
    await expect(effort).toHaveAccessibleDescription("vom Test vorgeschlagen");
    await effort.check();
    await expect(effort).toHaveAccessibleDescription("von dir geändert");
    await options
      .getByRole("button", {
        name: "Standard wiederherstellen für Chat Completions",
        exact: true,
      })
      .click();
    await expect(status).toHaveText("Standard für Chat Completions wiederhergestellt.");
    await expect(effort).toHaveAccessibleDescription("Standard");
  });

  test.describe("narrow screen", () => {
    test.use({ viewport: { width: 390, height: 844 } });
    test("the longest German option texts fit without overflow", async ({ page }) => {
      const { dialog, status, runTest } = await openEndpoint(page, { labels: GERMAN });
      await runTest({
        chatCompletions: { reasoningEffort: false, systemMessages: "inline" },
      });
      await expect(status).toHaveText(
        "Adapter-Optionen mit den Testvorschlägen aktualisiert.",
      );
      const options = await openChatOptions(dialog, "Adapter-Optionen");
      await options.scrollIntoViewIfNeeded();
      await expect(
        options.getByText("vom Test vorgeschlagen", { exact: true }),
      ).toHaveCount(2);
      const details = dialog.locator(".endpoint-adapter");
      const overflow = await details.evaluate((element) => ({
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        dialog:
          element.closest("dialog").scrollWidth - element.closest("dialog").clientWidth,
        options: element.scrollWidth - element.clientWidth,
      }));
      expect(overflow).toEqual({ page: 0, dialog: 0, options: 0 });
    });
  });
});
