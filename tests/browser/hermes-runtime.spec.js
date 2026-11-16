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
    // Hermes's traits (ADR 0007): "Every command" is one of its shell levels.
    approvals: {
      available: true,
      shellLevels: ["off", "approval", "every", "full"],
      allowlist: "exactCommands",
    },
    config: { available: true },
    agents: { available: true },
    agentFiles: unavailable(),
    routines: unavailable(),
    skills: unavailable(),
    browser: unavailable(),
    models: unavailable(),
    channels: unavailable(),
    advancedSettings: { available: true },
  },
};

// The runtime list (GET /api/assistant-runtimes, the live topic `runtimes`) with
// Hermes in install state `state`; null is a server without an optional runtime.
const runtimeList = (state) => ({
  runtimes: [
    {
      id: "openclaw",
      name: "OpenClaw",
      version: "2026.10.3",
      capabilities: {},
      install: { kind: "builtin" },
      ready: true,
    },
    ...(state
      ? [
          {
            ...hermesInfo,
            version: state.version,
            // Its install group is its own surface in the slot of Agents › Runtime.
            surfaces: [
              { id: "install", slot: "hub.runtime", kind: "built", shows: "always" },
            ],
            install: { kind: "optional", ...state },
            ready: state.enabled && state.installed,
          },
        ]
      : []),
  ],
});

/**
 * The Hermes endpoints and the runtime list that carries Hermes's state: the list
 * answers `state` until `show(next)` changes it, as an action's answer does. The
 * actions are recorded in `sent`. `listed: false` is a server whose list fails.
 */
async function hermesRoutes(page, state, answers = {}, { listed = true } = {}) {
  const sent = [];
  let current = state;
  await page.route(/\/api\/assistant-runtimes$/, (route) =>
    listed
      ? route.fulfill({ json: runtimeList(current) })
      : route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await page.route(/\/api\/assistant-runtime\/hermes/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "GET" && answers[`GET ${path}`])
      return route.fulfill({ json: answers[`GET ${path}`] });
    // The web app reads the state from the runtime list alone.
    if (method === "GET") return route.fulfill({ status: 500, json: {} });
    sent.push([method, path, request.postDataJSON()]);
    const answer = answers[`${method} ${path}`];
    if (answer) current = answer;
    return route.fulfill({ status: method === "POST" ? 202 : 200, json: answer });
  });
  return {
    sent,
    show(next) {
      current = next;
    },
  };
}
// Stops the mocks of hermesRoutes, before another state's are set up.
async function unrouteHermes(page) {
  await page.unroute(/\/api\/assistant-runtime\/hermes/);
  await page.unroute(/\/api\/assistant-runtimes$/);
}
const group = (page) => page.getByRole("region", { name: "Hermes Agent" });

test("switching Hermes on installs it and shows its version", async ({
  page,
  liveStub,
}) => {
  await setup(page);
  const installing = { ...off, enabled: true, installing: true };
  const { sent, show } = await hermesRoutes(page, off, {
    "PUT /api/assistant-runtime/hermes": installing,
  });
  await page.goto(baseURL + "/agents?tab=runtime");
  const hermes = group(page);
  await expect(hermes.getByText("Off", { exact: true })).toBeVisible();
  const toggle = hermes.getByRole("switch", { name: "Offer Hermes Agent" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  // The switch announces the installation's start: the list is pushed.
  await expect.poll(() => sent.length).toBe(1);
  await liveStub.reread("runtimes");
  await expect(hermes.getByText("Installing Hermes Agent …")).toBeVisible();
  await expect(toggle).toBeDisabled();
  expect(sent).toEqual([["PUT", "/api/assistant-runtime/hermes", { enabled: true }]]);
  // Its end is pushed too: nothing is polled meanwhile.
  show(installed);
  await liveStub.reread("runtimes");
  await expect(hermes.getByText("Ready", { exact: true })).toBeVisible();
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(hermes.getByText("0.22.5")).toBeVisible();
  await expect(hermes.getByText("Python 3.14.10")).toBeVisible();
  await expect(hermes.getByText("Agents on Hermes")).toBeVisible();
  await expect(hermes.getByRole("button", { name: "Update" })).toHaveCount(0);
});

test("an available update installs the pinned version; errors are named", async ({
  page,
  liveStub,
}) => {
  await setup(page);
  const outdated = { ...installed, targetVersion: "0.23.0", updateAvailable: true };
  const updating = { ...outdated, updating: true };
  const failed = { ...outdated, error: "HERMES_UPDATE_FAILED" };
  const { sent, show } = await hermesRoutes(page, outdated, {
    "POST /api/assistant-runtime/hermes/update": updating,
  });
  await page.goto(baseURL + "/agents?tab=runtime");
  const hermes = group(page);
  await expect(hermes.getByText("Pinned version 0.23.0")).toBeVisible();
  await expect(
    hermes.getByText("Hermes agents restart during the update."),
  ).toBeVisible();
  await hermes.getByRole("button", { name: "Update" }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent).toEqual([["POST", "/api/assistant-runtime/hermes/update", {}]]);
  await liveStub.reread("runtimes");
  await expect(hermes.getByText("Updating Hermes Agent …")).toBeVisible();
  await expect(hermes.getByRole("button", { name: "Update" })).toBeDisabled();
  // The update's end is pushed with its error.
  show(failed);
  await liveStub.reread("runtimes");
  await expect(
    hermes.getByText(
      "The update failed. Hermes Agent keeps running on its previous version.",
    ),
  ).toBeVisible();
});

test("work of Hermes agents that blocks the update is listed and can be paused", async ({
  page,
}) => {
  await setup(page);
  const outdated = { ...installed, targetVersion: "0.23.0", updateAvailable: true };
  const turn = {
    id: "chat_turn:t1",
    code: "ASSISTANT_WORK",
    kind: "chat_turn",
    agent: { id: "home", name: "Hermes helper" },
    since: "2026-11-01T10:00:00.000Z",
    link: "/agents/home/chats/c1",
    resolution: "stop",
    revision: "r1",
  };
  const blocked = { ...outdated, error: "UPDATE_BLOCKED", blockerItems: [turn] };
  const { sent } = await hermesRoutes(page, blocked, {
    "GET /api/assistant-runtime/hermes/update/blockers": { items: [turn] },
    "POST /api/assistant-runtime/hermes/update": { ...outdated, updating: true },
  });
  await page.goto(baseURL + "/agents?tab=runtime");
  const hermes = group(page);
  await expect(
    hermes.getByText(
      "Hermes agents are still working. Open each item below, or pause the agents and update.",
    ),
  ).toBeVisible();
  await expect(hermes.getByRole("link", { name: /Hermes helper/ })).toHaveAttribute(
    "href",
    "/agents/home/chats/c1",
  );
  await hermes.getByRole("button", { name: "Pause agents and update" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/Hermes helper/)).toBeVisible();
  await dialog.getByRole("button", { name: "Pause and update" }).click();
  await expect(dialog).toHaveCount(0);
  expect(sent).toEqual([
    [
      "POST",
      "/api/assistant-runtime/hermes/update",
      { resolveBlockers: true, items: [{ id: "chat_turn:t1", revision: "r1" }] },
    ],
  ]);
});

test("an unknown error code falls back; a server without Hermes shows no group", async ({
  page,
}) => {
  await setup(page);
  await hermesRoutes(page, { ...installed, error: "HERMES_SOMETHING_NEW" });
  await page.goto(baseURL + "/agents?tab=runtime");
  await expect(
    group(page).getByText("Hermes Agent reported a problem (HERMES_SOMETHING_NEW)."),
  ).toBeVisible();
  // A list without an optional runtime.
  await unrouteHermes(page);
  await hermesRoutes(page, null);
  await page.reload();
  await expect(page.getByRole("heading", { name: "OpenClaw updates" })).toBeVisible();
  await expect(group(page)).toHaveCount(0);
});

test("the search finds the Hermes group before Hermes is installed and lands on it", async ({
  page,
}) => {
  await setup(page);
  await hermesRoutes(page, off);
  // What the search reads beside the runtime list: no connection names, pipelines or projects.
  await page.route(
    /\/api\/(?:ssh-accesses|mcp-servers|secrets|repositories|pipelines|memory\/projects)(?:\?.*)?$/,
    (route) => route.fulfill({ json: [] }),
  );
  await page.goto(baseURL + "/agents");
  await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
  const mac = await page.evaluate(() => /mac/i.test(navigator.platform));
  await page.keyboard.press(mac ? "Meta+k" : "Control+k");
  const search = page.getByRole("dialog", { name: "Search" });
  await search.getByRole("combobox").fill("second runtime");
  await expect(search.getByRole("option").first()).toContainText(
    "Agents › Runtime › Hermes Agent",
  );
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/agents\?tab=runtime&section=runtimes$/);
  await expect(group(page)).toBeInViewport();
  await expect(group(page).getByText("Off", { exact: true })).toBeVisible();
  // A server without the surface has nothing to find.
  await unrouteHermes(page);
  await hermesRoutes(page, null);
  await page.reload();
  await expect(page.getByRole("heading", { name: "OpenClaw updates" })).toBeVisible();
  await page.keyboard.press(mac ? "Meta+k" : "Control+k");
  await search.getByRole("combobox").fill("second runtime");
  await expect(search).toContainText("Nothing found for “second runtime”");
});

/** The wizard's mocks: the create request is recorded in `sent`. */
async function wizard(page, hermes, assistants, { listed = true } = {}) {
  const state = await setupAssistantSettings(page, { assistants });
  // The runtimes a new agent may choose, with their traits and install state
  // (ADR 0007).
  await hermesRoutes(page, hermes, {}, { listed });
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

test("without the runtime list the wizard offers no choice and a duplicate keeps its level", async ({
  page,
}) => {
  const source = home({
    runtime: "hermes",
    runtimeInfo: hermesInfo,
    skills: [],
    shell: "approval",
    shellEveryCommand: true,
  });
  const sent = await wizard(page, installed, [source], { listed: false });
  // A new agent: how Hermes behaves is unknown, so it is not offered.
  await page.goto(baseURL + "/agents?new=1");
  await expect(page.getByRole("radio", { name: /^Blank/ })).toBeChecked();
  await expect(runtimeGroup(page)).toHaveCount(0);
  // A duplicate knows its runtime from its source: all four levels, its own checked.
  await page.goto(baseURL + "/agents?new=1&duplicate=home");
  await expect(
    runtimeGroup(page).getByText("Hermes Agent", { exact: true }),
  ).toBeVisible();
  await wizardNext(page);
  await wizardNext(page);
  const shell = page.locator("#agent-shell");
  await expect(shell.getByRole("radio")).toHaveCount(4);
  await expect(shell.getByRole("radio", { name: "Every command" })).toBeChecked();
  await wizardNext(page);
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
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
  await unrouteHermes(page);
  await hermesRoutes(page, off);
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
    // Each level is a row with its own explanation, readable on a phone.
    for (const radio of await shell.getByRole("radio").all())
      await expect(radio).toHaveAccessibleDescription(/\S/);
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
        capabilities: {
          approvals: {
            available: true,
            shellLevels: ["off", "approval", "full"],
            allowlist: "patterns",
          },
        },
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
