import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { home, setupAssistantSettings } from "../helpers/assistant-settings-browser.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";
import { wizardNext } from "../helpers/agent-wizard-browser.js";
import { setup } from "./assistant-teams-fixture.js";

// AGENTPIER-332: Hermes Agent as a second runtime. Agents › Runtime switches it on and
// updates it, the wizard offers it per agent, and a Hermes agent's settings show its
// four shell levels and what it does not offer yet.
const installed = {
  enabled: true,
  installing: false,
  installed: true,
  version: "0.22.5",
  targetVersion: "0.22.5",
  pythonVersion: "3.14.10",
  candidateReady: false,
  updateAvailable: false,
  updating: false,
  error: null,
  agents: 2,
};
const off = {
  ...installed,
  enabled: false,
  installed: false,
  version: null,
  pythonVersion: null,
  agents: 0,
};
const unavailable = (reason = "hermesNotYetSupported") => ({ available: false, reason });
const hermesInfo = {
  id: "hermes",
  name: "Hermes Agent",
  version: "0.22.5",
  capabilities: {
    host: { available: true },
    sessions: { available: true },
    events: { available: true },
    approvals: { available: true },
    config: { available: true },
    agents: { available: true },
    everyCommandApproval: { available: true },
    agentFiles: unavailable(),
    routines: unavailable(),
    skills: unavailable(),
    browser: unavailable(),
    models: unavailable(),
    channels: unavailable(),
    advancedSettings: unavailable("advancedSettingsUnsupported"),
  },
};

/** The Hermes endpoints: `states` answer the reads in turn, the last one repeats. */
async function hermesRoutes(page, states, answers = {}) {
  const sent = [];
  const queue = [...states];
  await page.route(/\/api\/assistant-runtime\/hermes/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "GET") {
      const state = queue.length > 1 ? queue.shift() : queue[0];
      return route.fulfill(state ? { json: state } : { status: 404, json: {} });
    }
    sent.push([method, path, request.postDataJSON()]);
    const answer = answers[`${method} ${path}`];
    return route.fulfill({ status: method === "POST" ? 202 : 200, json: answer });
  });
  return sent;
}
const group = (page) => page.getByRole("region", { name: "Hermes Agent" });

test("switching Hermes on installs it and shows its version", async ({ page }) => {
  await setup(page);
  const installing = { ...off, enabled: true, installing: true };
  const sent = await hermesRoutes(page, [off, installing, installed], {
    "PUT /api/assistant-runtime/hermes": installing,
  });
  await page.goto(baseURL + "/agents?tab=runtime");
  const hermes = group(page);
  await expect(hermes.getByText("Off", { exact: true })).toBeVisible();
  const toggle = hermes.getByRole("switch", { name: "Offer Hermes Agent" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(hermes.getByText("Installing Hermes Agent …")).toBeVisible();
  await expect(toggle).toBeDisabled();
  expect(sent).toEqual([["PUT", "/api/assistant-runtime/hermes", { enabled: true }]]);
  // The state is read again every 2 s until the install has finished.
  await expect(hermes.getByText("Ready", { exact: true })).toBeVisible({
    timeout: 8000,
  });
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(hermes.getByText("0.22.5")).toBeVisible();
  await expect(hermes.getByText("Python 3.14.10")).toBeVisible();
  await expect(hermes.getByText("Agents on Hermes")).toBeVisible();
  await expect(hermes.getByRole("button", { name: "Update" })).toHaveCount(0);
});

test("an available update installs the pinned version; errors are named", async ({
  page,
}) => {
  await setup(page);
  const outdated = { ...installed, targetVersion: "0.23.0", updateAvailable: true };
  const updating = { ...outdated, updating: true };
  const failed = { ...outdated, error: "HERMES_UPDATE_FAILED" };
  const sent = await hermesRoutes(page, [outdated, updating, failed], {
    "POST /api/assistant-runtime/hermes/update": updating,
  });
  await page.goto(baseURL + "/agents?tab=runtime");
  const hermes = group(page);
  await expect(hermes.getByText("Pinned version 0.23.0")).toBeVisible();
  await expect(
    hermes.getByText("Hermes agents restart during the update."),
  ).toBeVisible();
  await hermes.getByRole("button", { name: "Update" }).click();
  expect(sent).toEqual([["POST", "/api/assistant-runtime/hermes/update", {}]]);
  await expect(hermes.getByText("Updating Hermes Agent …")).toBeVisible();
  await expect(hermes.getByRole("button", { name: "Update" })).toBeDisabled();
  await expect(
    hermes.getByText(
      "The update failed. Hermes Agent keeps running on its previous version.",
    ),
  ).toBeVisible({ timeout: 8000 });
});

test("an unknown error code falls back; a server without Hermes shows no group", async ({
  page,
}) => {
  await setup(page);
  await hermesRoutes(page, [{ ...installed, error: "HERMES_SOMETHING_NEW" }]);
  await page.goto(baseURL + "/agents?tab=runtime");
  await expect(
    group(page).getByText("Hermes Agent reported a problem (HERMES_SOMETHING_NEW)."),
  ).toBeVisible();
  await page.unroute(/\/api\/assistant-runtime\/hermes/);
  await hermesRoutes(page, [null]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "OpenClaw updates" })).toBeVisible();
  await expect(group(page)).toHaveCount(0);
});

/** The wizard's mocks: the create request is recorded in `sent`. */
async function wizard(page, hermes, assistants) {
  const state = await setupAssistantSettings(page, { assistants });
  await hermesRoutes(page, [hermes]);
  const sent = [];
  await page.route(/\/api\/assistants/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/assistants" && request.method() === "POST") {
      sent.push(request.postDataJSON());
      const fresh = home({ id: "fresh", name: "Scout", revision: 3 });
      state.assistants.push(fresh);
      return route.fulfill({ status: 201, json: fresh });
    }
    if (path === "/api/assistants/fresh/conversations")
      return route.fulfill({ json: { id: "fresh-chat", assistantId: "fresh" } });
    if (path === "/api/assistants/fresh/access" || path === "/api/assistants/home/access")
      return route.fulfill({ json: { revision: 1 } });
    return route.fallback();
  });
  return sent;
}
const runtimeGroup = (page) => page.getByRole("region", { name: "Runtime" });
async function identity(page) {
  await page.getByLabel("Name", { exact: true }).fill("Scout");
  await page
    .getByRole("combobox", { name: "Model connection" })
    .selectOption({ label: "Router" });
  const model = page.getByRole("textbox", { name: "Model ID" });
  if (!(await model.inputValue())) await model.fill("model");
}

test("the wizard offers Hermes while it is installed and sends its shell choice", async ({
  page,
}) => {
  const sent = await wizard(page, installed);
  await page.goto(baseURL + "/agents?new=1");
  const runtimes = runtimeGroup(page);
  await expect(runtimes.getByRole("radio", { name: /^OpenClaw/ })).toBeChecked();
  await runtimes.getByRole("radio", { name: /^Hermes Agent/ }).check();
  // Switching between blank and template keeps the chosen runtime.
  await page.getByRole("radio", { name: /^From template/ }).check();
  await page.getByRole("radio", { name: /^Blank/ }).check();
  await expect(runtimes.getByRole("radio", { name: /^Hermes Agent/ })).toBeChecked();
  await wizardNext(page);
  await identity(page);
  await wizardNext(page);
  const shell = page.locator("#agent-shell");
  await expect(shell.getByRole("radio")).toHaveCount(4);
  await shell.getByRole("radio", { name: "Every command" }).check();
  await expect(
    shell.getByText("Every shell command and Python run asks you first."),
  ).toBeVisible();
  await wizardNext(page);
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(page.getByText("Hermes Agent", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(page).toHaveURL(/\/agents\/fresh\/chats\/fresh-chat$/);
  expect(sent[0]).toMatchObject({
    runtime: "hermes",
    shell: "approval",
    shellEveryCommand: true,
  });
});

test("a duplicate keeps its runtime; without Hermes the wizard has no choice", async ({
  page,
}) => {
  const source = home({ runtime: "hermes", runtimeInfo: hermesInfo, skills: [] });
  const sent = await wizard(page, installed, [source]);
  await page.goto(baseURL + "/agents?new=1&duplicate=home");
  await expect(page.getByRole("radio", { name: /^Duplicate/ })).toBeChecked();
  const runtimes = runtimeGroup(page);
  await expect(runtimes.getByText("Hermes Agent", { exact: true })).toBeVisible();
  await expect(runtimes.getByRole("radio")).toHaveCount(0);
  await wizardNext(page);
  await wizardNext(page);
  await wizardNext(page);
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(page).toHaveURL(/\/agents\/fresh\/chats\/fresh-chat$/);
  expect(sent[0].runtime).toBe("hermes");
  // Leaving the duplicate resets the runtime to the default.
  await page.goto(baseURL + "/agents?new=1&duplicate=home");
  await expect(
    runtimeGroup(page).getByText("Hermes Agent", { exact: true }),
  ).toBeVisible();
  await page.getByRole("radio", { name: /^Blank/ }).check();
  await expect(
    runtimeGroup(page).getByRole("radio", { name: /^OpenClaw/ }),
  ).toBeChecked();
  await page.unroute(/\/api\/assistant-runtime\/hermes/);
  await hermesRoutes(page, [off]);
  await page.goto(baseURL + "/agents?new=1");
  await expect(page.getByRole("radio", { name: /^Blank/ })).toBeChecked();
  await expect(runtimeGroup(page)).toHaveCount(0);
  await wizardNext(page);
  await identity(page);
  await wizardNext(page);
  await expect(page.locator("#agent-shell").getByRole("radio")).toHaveCount(3);
});

for (const [language, texts] of [
  [
    "en",
    {
      gate: "Not available for Hermes agents yet.",
      every: "Every command",
      save: "Save agent",
    },
  ],
  [
    "de",
    {
      gate: "Kommt bald für Hermes-Agenten.",
      every: "Jeder Befehl",
      save: "Agent speichern",
    },
  ],
]) {
  test(`a Hermes agent gates its memory and saves every command (${language})`, async ({
    page,
  }) => {
    const state = await setupAssistantSettings(page, {
      language,
      assistant: { runtime: "hermes", runtimeInfo: hermesInfo, shell: "off" },
      applyUpdates: true,
    });
    await page.goto(baseURL + settingsPath("capabilities"));
    await expect(page.locator("[data-capability='agentFiles']")).toContainText(
      texts.gate,
    );
    const shell = page.locator("#agent-shell");
    await expect(shell.getByRole("radio")).toHaveCount(4);
    await shell.getByRole("radio", { name: texts.every }).check();
    const bar = saveBar(
      page,
      language === "de" ? "Ungespeicherte Änderungen" : undefined,
    );
    await bar.getByRole("button", { name: texts.save }).click();
    await expect
      .poll(() => state.updates.at(-1))
      .toMatchObject({
        shell: "approval",
        shellEveryCommand: true,
      });
  });
}

test("an OpenClaw agent keeps its three shell levels and sends no every-command field", async ({
  page,
}) => {
  const state = await setupAssistantSettings(page, {
    assistant: {
      runtimeInfo: {
        id: "openclaw",
        name: "OpenClaw",
        version: "2026.10.3",
        capabilities: { everyCommandApproval: unavailable("approvalAsksEveryCommand") },
      },
      shell: "off",
    },
  });
  await page.goto(baseURL + settingsPath("capabilities"));
  const shell = page.locator("#agent-shell");
  await expect(shell.getByRole("radio")).toHaveCount(3);
  await shell.getByRole("radio", { name: "With approval" }).check();
  await saveBar(page).getByRole("button", { name: "Save agent" }).click();
  await expect.poll(() => state.updates.length).toBe(1);
  expect(state.updates[0].shell).toBe("approval");
  expect("shellEveryCommand" in state.updates[0]).toBe(false);
});
