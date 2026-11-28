import fs from "node:fs";
import path from "node:path";
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { settingsPath } from "../helpers/agent-settings-page.js";
import { home, setupAssistantSettings } from "../helpers/assistant-settings-browser.js";
import { isLiveStubRequest } from "../helpers/live-stub.js";

test.use({ locale: "en-GB" });

// The owner's semantic memory search on Agents › Runtime: each state the server
// reports (the live topic `runtime.semantic-memory`, read from its route here and
// pushed per step), the switch with its confirmation, and the hint on an agent's
// memory page. Set AGENTPIER_SCREENSHOT_DIR to keep a screenshot of each state.
const shots = process.env.AGENTPIER_SCREENSHOT_DIR;
async function shoot(target, name) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await target.screenshot({ path: path.join(shots, `semantic-memory-${name}.png`) });
}
const topic = "runtime.semantic-memory";
const model = {
  id: "embeddinggemma-300m-qat-q8_0",
  size: 328577056,
  termsUrl: "https://ai.google.dev/gemma/terms",
};
const status = (patch = {}) => ({
  available: true,
  enabled: false,
  state: "off",
  progress: null,
  failure: null,
  pending: false,
  revision: 1,
  model,
  ...patch,
});

// The route as the server answers it (routes/assistant-semantic-memory.js): a PUT
// answers 202 with the first state of the switch, or `refusal`.
async function setup(page, initial = {}, options = {}) {
  const state = await setupAssistantSettings(page, options);
  state.semantic = status(initial);
  state.semanticPuts = [];
  state.semanticReads = 0;
  await page.route("**/api/assistant-semantic-memory", (route) => {
    const request = route.request();
    if (request.method() !== "PUT") {
      if (!isLiveStubRequest(request)) state.semanticReads += 1;
      return route.fulfill({ json: state.semantic });
    }
    const body = request.postDataJSON();
    state.semanticPuts.push(body);
    if (state.refusal) return route.fulfill(state.refusal);
    state.semantic = status(
      body.enabled
        ? {
            state: "downloading",
            progress: { received: 0, total: model.size },
            revision: body.revision + 1,
          }
        : {
            enabled: true,
            state: "rebuilding",
            progress: { target: "keyword", phase: "stopping", done: 0, total: 0 },
            revision: body.revision + 1,
          },
    );
    return route.fulfill({ status: 202, json: state.semantic });
  });
  return state;
}
const group = (page) => page.getByRole("region", { name: "Semantic memory search" });
// A change the service signals: the server pushes the new value.
async function push(liveStub, state, patch) {
  state.semantic = status({ ...patch });
  await liveStub.pushRest(topic);
}

test("switching on asks first, then shows the download, the rebuild and the result", async ({
  page,
  liveStub,
}) => {
  const state = await setup(page);
  await page.goto(baseURL + "/agents?tab=runtime&section=memory-search");
  const region = group(page);
  await expect(region).toContainText("Find notes by meaning");
  // What it costs, with the model's own size.
  await expect(region).toContainText("a one-time download of 313.4 MB");
  await expect(region).toContainText("about 550 to 750 MB of memory while agents search");
  await expect(region).toContainText("no memory content leaves it");
  await expect(region).toContainText("Hermes agents load their memory into every chat");
  await expect(region.locator(".list-row-status")).toHaveText("Off");
  await shoot(region, "off");

  await region.getByRole("button", { name: "Turn on …" }).click();
  const dialog = page.getByRole("dialog", { name: "Turn on semantic memory search?" });
  await expect(dialog).toContainText("downloads the embedding model (313.4 MB)");
  await expect(dialog).toContainText("Running agent work is interrupted");
  await expect(dialog).toContainText("keyword search is restored and this stays off");
  const terms = dialog.getByRole("link", { name: "Gemma terms of use" });
  await expect(terms).toHaveAttribute("href", model.termsUrl);
  await expect(terms).toHaveAttribute("target", "_blank");
  await shoot(dialog, "confirm-on");
  // Cancel is the default and switches nothing.
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.semanticPuts).toEqual([]);

  await region.getByRole("button", { name: "Turn on …" }).click();
  await dialog.getByRole("button", { name: "Download and turn on" }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.semanticPuts).toEqual([{ enabled: true, revision: 1, acceptTerms: true }]);
  await expect(region.locator(".list-row-status")).toHaveText("Downloading");
  // While it runs the switch is locked.
  await expect(region.getByRole("button", { name: "Turn on …" })).toBeDisabled();

  const running = { revision: 2 };
  await push(liveStub, state, {
    ...running,
    state: "downloading",
    progress: { received: 104857600, total: model.size },
  });
  await expect(region.getByRole("status")).toHaveText(
    "Downloading the embedding model: 100 MB of 313.4 MB",
  );
  await shoot(region, "downloading");
  const rebuilding = (progress) =>
    push(liveStub, state, {
      ...running,
      enabled: true,
      state: "rebuilding",
      progress: { target: "local", done: 0, total: 0, ...progress },
    });
  await rebuilding({ phase: "stopping" });
  await expect(region.locator(".list-row-status")).toHaveText("Rebuilding");
  await expect(region.getByRole("status")).toHaveText("Stopping the agent service");
  await rebuilding({ phase: "indexing", done: 2, total: 5 });
  await expect(region.getByRole("status")).toHaveText(
    "Rebuilding the memory indexes: 2 of 5 agents",
  );
  await shoot(region, "rebuilding");
  await rebuilding({ phase: "starting", done: 5, total: 5 });
  await expect(region.getByRole("status")).toHaveText("Starting the agent service");

  await push(liveStub, state, { ...running, enabled: true, state: "on" });
  await expect(region.locator(".list-row-status")).toHaveText("On");
  await expect(region.getByRole("status")).toHaveCount(0);
  await expect(region.getByRole("button", { name: "Turn off …" })).toBeEnabled();
  await shoot(region, "on");
  // Every state came over the live channel: the page read the route once at most.
  expect(state.semanticReads).toBeLessThanOrEqual(2);
});

test("switching off says what is interrupted and removed", async ({ page, liveStub }) => {
  const state = await setup(page, { enabled: true, state: "on", revision: 4 });
  await page.goto(baseURL + "/agents?tab=runtime");
  const region = group(page);
  await region.getByRole("button", { name: "Turn off …" }).click();
  const dialog = page.getByRole("dialog", { name: "Turn off semantic memory search?" });
  await expect(dialog).toContainText(
    "rebuilds every agent's memory index for keyword search",
  );
  await expect(dialog).toContainText("Running agent work is interrupted");
  await expect(dialog).toContainText("The downloaded model is removed.");
  await shoot(dialog, "confirm-off");
  await dialog.getByRole("button", { name: "Turn off", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.semanticPuts).toEqual([{ enabled: false, revision: 4 }]);
  await expect(region.getByRole("status")).toHaveText("Stopping the agent service");
  await push(liveStub, state, { revision: 5 });
  await expect(region.locator(".list-row-status")).toHaveText("Off");
  await expect(region.getByRole("button", { name: "Turn on …" })).toBeEnabled();
});

test("a failure shows as off with its reason and can be tried again", async ({
  page,
}) => {
  await setup(page, {
    state: "failed",
    failure: { code: "MEMORY_INDEX_FAILED", at: 1 },
    revision: 3,
  });
  await page.goto(baseURL + "/agents?tab=runtime");
  const region = group(page);
  await expect(region.locator(".list-row-status")).toHaveText("Off");
  await expect(region.getByRole("alert")).toHaveText(
    "The memory indexes could not be rebuilt with the embedding model. Keyword search was restored.",
  );
  await expect(region.getByRole("button", { name: "Turn on …" })).toBeEnabled();
  await shoot(region, "failed");
});

test("on but not working shows as degraded with the reason and offers a repair", async ({
  page,
  liveStub,
}) => {
  const state = await setup(page, { enabled: true, state: "on", revision: 6 });
  await page.goto(baseURL + "/agents?tab=runtime");
  const region = group(page);
  await expect(region.locator(".list-row-status")).toHaveText("On");
  await expect(region.getByRole("button", { name: "Repair …" })).toHaveCount(0);
  // A memory search answered without embeddings: the server pushes the new state.
  await push(liveStub, state, {
    enabled: true,
    state: "degraded",
    degraded: { code: "EMBEDDINGS_UNAVAILABLE", at: 1 },
    revision: 6,
  });
  await expect(region.locator(".list-row-status")).toHaveText("Not working");
  await expect(region.getByRole("alert")).toHaveText(
    "Semantic search is on but not working: memory search answers by keyword only. The embedding server did not answer the last memory search.",
  );
  // Turning it off stays possible beside the repair.
  await expect(region.getByRole("button", { name: "Turn off …" })).toBeEnabled();
  await shoot(region, "degraded");
  await region.getByRole("button", { name: "Repair …" }).click();
  const dialog = page.getByRole("dialog", { name: "Repair semantic memory search?" });
  await expect(dialog).toContainText("installs the llama.cpp server again");
  await expect(dialog).toContainText("Running agent work is interrupted");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Repair", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // No second consent to the model terms: it is on already.
  expect(state.semanticPuts).toEqual([{ enabled: true, revision: 6, repair: true }]);
  await expect(region.locator(".list-row-status")).toHaveText("Downloading");
  await expect(region.getByRole("button", { name: "Repair …" })).toHaveCount(0);
});

test("where it cannot run the switch is locked with the reason", async ({ page }) => {
  await setup(page, { available: false, reason: "RUNTIME_UPDATE_REQUIRED" });
  await page.goto(baseURL + "/agents?tab=runtime");
  const region = group(page);
  const action = region.getByRole("button", { name: "Turn on …" });
  await expect(action).toBeDisabled();
  await expect(action).toContainText(
    "Needs the current OpenClaw runtime. Activate the update under OpenClaw updates first.",
  );
  await shoot(region, "unavailable");
});

test("a setting that waits for the agent service says so", async ({ page }) => {
  await setup(page, { enabled: true, state: "on", pending: true });
  await page.goto(baseURL + "/agents?tab=runtime");
  await expect(group(page)).toContainText(
    "On. The memory indexes are rebuilt when the agent service starts.",
  );
});

test("a refused switch keeps the dialog open with the reason", async ({ page }) => {
  const state = await setup(page);
  state.refusal = {
    status: 409,
    json: {
      code: "SEMANTIC_MEMORY_OPERATION_RUNNING",
      error: "SEMANTIC_MEMORY_OPERATION_RUNNING",
    },
  };
  await page.goto(baseURL + "/agents?tab=runtime");
  await group(page).getByRole("button", { name: "Turn on …" }).click();
  const dialog = page.getByRole("dialog", { name: "Turn on semantic memory search?" });
  await dialog.getByRole("button", { name: "Download and turn on" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("A switch is already in progress.");
  await expect(dialog).toBeVisible();
});

test("the group is found by search and in German", async ({ page }) => {
  await setup(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "de"));
  await page.goto(baseURL + "/agents?tab=runtime");
  const region = page.getByRole("region", { name: "Semantische Gedächtnissuche" });
  await expect(region).toContainText("Notizen nach Bedeutung finden");
  await expect(region.locator(".list-row-status")).toHaveText("Aus");
  await region.getByRole("button", { name: "Einschalten …" }).click();
  await expect(
    page.getByRole("dialog", { name: "Semantische Gedächtnissuche einschalten?" }),
  ).toContainText("Laufende Agentenarbeit wird unterbrochen");
});

const openClaw = { id: "openclaw", name: "OpenClaw", capabilities: {} };
const hermes = {
  id: "hermes",
  name: "Hermes Agent",
  capabilities: {
    semanticMemory: { available: false, reason: "semanticMemoryUnsupported" },
  },
};
const agent = (runtimeInfo) =>
  home({
    name: "Fern",
    runtime: runtimeInfo.id,
    runtimeInfo,
    capabilities: { memory: true, reminders: false },
  });
const hint =
  "Semantic memory search is on: the search and the agent also find notes by meaning.";

test("an OpenClaw agent's memory page says when its search works by meaning", async ({
  page,
  liveStub,
}) => {
  const state = await setup(
    page,
    { enabled: true, state: "on" },
    { assistants: [agent(openClaw)] },
  );
  await page.goto(baseURL + settingsPath("capabilities", "memory"));
  await expect(page.getByText(hint)).toBeVisible();
  await shoot(page.locator("main"), "agent-memory-hint");
  // Not working: the hint would be untrue, so it goes.
  await push(liveStub, state, {
    enabled: true,
    state: "degraded",
    degraded: { code: "EMBEDDING_MODEL_MISSING" },
  });
  await expect(page.getByText(hint)).toHaveCount(0);
  await push(liveStub, state, { enabled: true, state: "on" });
  await expect(page.getByText(hint)).toBeVisible();
  // Off again: the hint goes without a reload.
  await push(liveStub, state, {});
  await expect(page.getByText(hint)).toHaveCount(0);
});

test("a Hermes agent's memory page shows nothing of it and reads nothing", async ({
  page,
}) => {
  const state = await setup(
    page,
    { enabled: true, state: "on" },
    { assistants: [agent(hermes)] },
  );
  let stubReads = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/assistant-semantic-memory")) stubReads += 1;
  });
  await page.goto(baseURL + settingsPath("capabilities", "memory"));
  await expect(page.getByRole("button", { name: "Search", exact: true })).toBeVisible();
  await expect(page.getByText(hint)).toHaveCount(0);
  expect(state.semanticReads).toBe(0);
  expect(stubReads).toBe(0);
});
