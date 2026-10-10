import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

async function setup(page) {
  const controls = await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const models = [
    { id: "router", name: "OpenRouter", providerId: "openrouter", available: true },
    {
      id: "router-two",
      name: "OpenRouter second",
      providerId: "openrouter",
      available: true,
    },
    ...["Ollama", "llama.cpp"].map((name) => ({
      id: name,
      name,
      providerId: "endpoint",
      available: true,
      models: [
        { modelId: "qwen3:4b", label: "Qwen 3 4B" },
        { modelId: "llama3.2", label: "Llama 3.2" },
      ],
    })),
  ];
  const created = [];
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    if (path === "/api/assistants") {
      if (route.request().method() === "POST") {
        created.push(route.request().postDataJSON());
        return route.fulfill({ json: { id: "new", ...created.at(-1) } });
      }
      return route.fulfill({ json: { assistants: [], conversations: [], models } });
    }
    if (path === "/api/assistant-runtime")
      return route.fulfill({ json: { availability: "ready", sync: "current" } });
    return route.fulfill({ json: {} });
  });
  await page.goto(baseURL + "/agents");
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  return { controls, created };
}

const picker = (page) => page.getByRole("combobox", { name: "Model", exact: true });
async function search(page, query) {
  await picker(page).click();
  await page.getByRole("combobox", { name: "Search models" }).fill(query);
}

test("OpenRouter loads a current searchable catalog when creating an agent", async ({
  page,
}) => {
  const { created } = await setup(page);
  await page.getByLabel("Name", { exact: true }).fill("Model search");
  await page.getByLabel("Model connection").selectOption("router");
  await expect(page.getByText("Current catalog", { exact: true })).toBeVisible();
  await search(page, "z-ai/glm");
  await page
    .getByRole("listbox")
    .getByRole("option", { name: /GLM 5.3/ })
    .click();
  await expect(picker(page)).toHaveValue("z-ai/glm-5.3");
  await page.getByRole("button", { name: "Save agent", exact: true }).click();
  await expect
    .poll(() => created.at(-1)?.model)
    .toEqual({ connectionId: "router", modelId: "z-ai/glm-5.3" });
});

for (const connection of ["Ollama", "llama.cpp"])
  test(`${connection} models can be searched by label and ID`, async ({ page }) => {
    await setup(page);
    await page.getByLabel("Model connection").selectOption(connection);
    await search(page, "Qwen 3");
    await page.getByRole("listbox").getByRole("option", { name: /Qwen/ }).click();
    await expect(picker(page)).toHaveValue("qwen3:4b");
    await search(page, "llama3.2");
    await page.getByRole("listbox").getByRole("option", { name: /Llama/ }).click();
    await expect(picker(page)).toHaveValue("llama3.2");
    await search(page, "no-such-model");
    await expect(
      page.getByText("No matching models found.", { exact: true }),
    ).toBeVisible();
  });

test("a failed OpenRouter catalog keeps manual entry and can be retried", async ({
  page,
}) => {
  const { controls } = await setup(page);
  controls.failCatalog = true;
  await page.getByLabel("Model connection").selectOption("router");
  await expect(page.getByText("Fixture catalog unavailable")).toBeVisible();
  await page.getByRole("textbox", { name: "Model ID", exact: true }).fill("custom/model");
  controls.failCatalog = false;
  await page.getByRole("button", { name: "Refresh model catalog" }).click();
  await expect(picker(page)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Model ID", exact: true })).toHaveValue(
    "custom/model",
  );
});

test("a late OpenRouter response cannot replace local models", async ({ page }) => {
  const { controls } = await setup(page);
  controls.holdProvider = "openrouter";
  await page.getByLabel("Model connection").selectOption("router");
  await expect.poll(() => typeof controls.release).toBe("function");
  await expect(
    page.getByText("Loading provider models …", { exact: true }).first(),
  ).toBeVisible();
  await page.getByLabel("Model connection").selectOption("Ollama");
  controls.holdProvider = null;
  controls.release();
  await search(page, "Qwen");
  await page.getByRole("listbox").getByRole("option", { name: /Qwen/ }).click();
  await expect(picker(page)).toHaveValue("qwen3:4b");
});

test("switching OpenRouter accounts preserves the selected model", async ({ page }) => {
  await setup(page);
  await page.getByLabel("Model connection").selectOption("router");
  await expect(page.getByText("Current catalog", { exact: true })).toBeVisible();
  await picker(page).selectOption("z-ai/glm-5.3");
  await page.getByLabel("Model connection").selectOption("router-two");
  await expect(picker(page)).toHaveValue("z-ai/glm-5.3");
});

test("a failed automatic refresh keeps the cached catalog searchable", async ({
  page,
}) => {
  const { controls } = await setup(page);
  controls.failRefresh = true;
  await page.getByLabel("Model connection").selectOption("router");
  await expect(page.getByText("Fixture catalog unavailable")).toBeVisible();
  await search(page, "glm");
  await page
    .getByRole("listbox")
    .getByRole("option", { name: /GLM 5.3/ })
    .click();
  await expect(picker(page)).toHaveValue("z-ai/glm-5.3");
});
