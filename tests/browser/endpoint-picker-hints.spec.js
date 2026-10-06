import { test, expect } from "@playwright/test";
import { pipelinesFixture, openPipelines } from "./pipelines-fixture.js";

test.use({ locale: "en-GB" });

test("a saved model missing from an endpoint connection keeps the unavailable hint", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  const manual = { source: "manual", contextEdited: true, outputTokens: null };
  const profile = state.profiles[0];
  state.connections.push({
    id: "ctx",
    name: "Ctx box",
    providerId: "endpoint",
    hasSecret: false,
    launchable: true,
    tools: [profile.config.cliTool],
    endpoint: {
      openaiBaseUrl: "http://gpu.example:11434/v1",
      anthropicBaseUrl: "",
      authHeader: "",
      protocols: { messages: true, responses: true, chatCompletions: true },
      models: [
        { ...manual, modelId: "ready:1", label: "ready:1", contextTokens: 8192 },
        { ...manual, modelId: "later:1", label: "later:1", contextTokens: null },
      ],
    },
  });
  profile.config.providerConnectionId = "ctx";
  profile.config.models = { available: ["gone:1"], default: "gone:1" };
  await openPipelines(page);
  await page.getByRole("button", { name: /^Edit: / }).click();
  await expect(
    page.getByText("The saved model is unavailable in the current catalog."),
  ).toBeVisible();
  await expect(page.getByText(/1 model needs a context size/)).toBeVisible();
  await expect(page.getByText("No matching models found for this CLI.")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Refresh model catalog", exact: true }),
  ).toHaveCount(0);
});
