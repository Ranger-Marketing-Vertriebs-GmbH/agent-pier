import { openNewSession } from "../helpers/navigation.js";
import { test, expect } from "@playwright/test";

import { baseURL as base } from "../helpers/browser.js";
async function launchFixture(page, { accept = false } = {}) {
  const launches = [];
  const tools = ["codex", "claude", "opencode"].map((id) => ({
    id,
    name: id,
    installed: true,
    path: `/bin/${id}`,
  }));
  const accounts = tools.map(({ id }) => ({
    id: `local-${id}`,
    tool: id,
    name: id,
    kind: "local",
    hasSecret: false,
    createdAt: null,
  }));
  await page.route("**/api/state", (route) =>
    route.fulfill({
      json: { tools, accounts, sessions: [], home: "/home/test", remoteUrl: null },
    }),
  );
  await page.route("**/api/sessions", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON();
    launches.push(body);
    return accept
      ? route.fulfill({
          status: 201,
          json: { ...body, id: `launched-${launches.length}`, status: "running" },
        })
      : route.fulfill({ status: 409, json: { error: "Test launch captured" } });
  });
  await page.goto(base);
  await openDialog(page);
  return launches;
}
async function openDialog(page) {
  await openNewSession(page);
}

test("new sessions default to Codex YOLO and Claude/OpenCode Auto", async ({ page }) => {
  const launches = await launchFixture(page);
  const mode = page.getByLabel("Startmodus", { exact: true });
  await expect(mode).toHaveValue("yolo");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Session starten", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText("Test launch captured");
  expect(launches[0]).toMatchObject({ accountId: "local-codex", launchMode: "yolo" });
  await mode.selectOption("default");
  await page.getByLabel("CLI", { exact: true }).selectOption("claude");
  await expect(mode).toHaveValue("auto");
  await expect(mode.locator('option[value="yolo"]')).toHaveCount(0);
  await mode.selectOption("auto");
  await page.getByLabel("CLI", { exact: true }).selectOption("opencode");
  await expect(mode).toHaveValue("auto");
  await page.getByLabel("CLI", { exact: true }).selectOption("codex");
  await expect(mode).toHaveValue("yolo");
});

for (const { tool, mode, note } of [
  { tool: "codex", mode: "yolo", note: /ohne Sandbox/ },
  { tool: "codex", mode: "default", note: /Voreinstellungen/ },
  { tool: "claude", mode: "auto", note: /Sicherheitsprüfung/ },
  {
    tool: "claude",
    mode: "bypass",
    note: /Ohne Rückfragen führt Claude.*Gilt nur für diese neue Session/,
  },
  { tool: "opencode", mode: "auto", note: /Verbote bleiben/ },
])
  test(`${tool} submits its explicitly selected ${mode} launch mode`, async ({
    page,
  }) => {
    const launches = await launchFixture(page);
    await page.getByLabel("CLI", { exact: true }).selectOption(tool);
    await page.getByLabel("Startmodus", { exact: true }).selectOption(mode);
    await expect(page.locator("#launch-mode-description")).toContainText(note);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Session starten", exact: true })
      .click();
    await expect(page.getByRole("alert")).toHaveText("Test launch captured");
    expect(launches[0]).toMatchObject({ accountId: `local-${tool}`, launchMode: mode });
  });

test("AgentBus is included by default and can be disabled for this launch without changing the account", async ({
  page,
}) => {
  const launches = await launchFixture(page);
  await page.locator(".launch-extensions > summary").click();
  const toggle = page.getByRole("checkbox", { name: /AgentBus/ });
  await expect(toggle).toBeChecked();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Session starten", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText("Test launch captured");
  expect(launches[0].agentbus).toBe(true);
  await toggle.uncheck();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Session starten", exact: true })
    .click();
  await expect.poll(() => launches.length).toBe(2);
  expect(launches[1].agentbus).toBe(false);
  expect(launches[1].accountId).toBe(launches[0].accountId);
});

test("Claude offers a skip-permissions mode with a risk note in English", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const launches = await launchFixture(page);
  await page.getByLabel("CLI", { exact: true }).selectOption("claude");
  const mode = page.getByLabel("Launch mode", { exact: true });
  await expect(mode).toHaveValue("auto");
  await expect(mode.locator('option[value="bypass"]')).toHaveText(
    "No permission prompts · no checks",
  );
  await mode.selectOption("bypass");
  await expect(page.locator("#launch-mode-description")).toHaveText(
    /runs every command and change without asking.*only to this new session/,
  );
  await page.getByLabel("CLI", { exact: true }).selectOption("codex");
  await expect(mode.locator('option[value="bypass"]')).toHaveCount(0);
  await page.getByLabel("CLI", { exact: true }).selectOption("claude");
  await mode.selectOption("bypass");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText("Test launch captured");
  expect(launches[0]).toMatchObject({ accountId: "local-claude", launchMode: "bypass" });
});

test("the dialog remembers the last launched mode per CLI, not a failed attempt", async ({
  page,
}) => {
  await launchFixture(page);
  await page.getByLabel("CLI", { exact: true }).selectOption("claude");
  await page.getByLabel("Startmodus", { exact: true }).selectOption("bypass");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Session starten", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText("Test launch captured");
  await page.reload();
  await openDialog(page);
  await page.getByLabel("CLI", { exact: true }).selectOption("claude");
  await expect(page.getByLabel("Startmodus", { exact: true })).toHaveValue("auto");
});

test("a successful launch preselects that mode next time for the same CLI only", async ({
  page,
}) => {
  const launches = await launchFixture(page, { accept: true });
  const dialog = page.getByRole("dialog");
  const mode = page.getByLabel("Startmodus", { exact: true });
  const cli = page.getByLabel("CLI", { exact: true });
  await cli.selectOption("claude");
  await mode.selectOption("bypass");
  await dialog.getByRole("button", { name: "Session starten", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await openDialog(page);
  await expect(mode).toHaveValue("yolo");
  await mode.selectOption("default");
  await dialog.getByRole("button", { name: "Session starten", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(launches.map((item) => [item.tool, item.launchMode])).toEqual([
    ["claude", "bypass"],
    ["codex", "default"],
  ]);
  await page.reload();
  await openDialog(page);
  await expect(mode).toHaveValue("default");
  await cli.selectOption("claude");
  await expect(mode).toHaveValue("bypass");
  await expect(page.locator("#launch-mode-description")).toContainText(
    "Ohne Rückfragen führt Claude",
  );
  await expect(page.locator("#launch-mode-description")).toContainText(
    "Aus deiner letzten Session vorausgewählt.",
  );
  await cli.selectOption("opencode");
  await expect(mode).toHaveValue("auto");
});

test("a remembered mode that the CLI does not offer falls back to the default", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "agentpier.launch-modes",
      JSON.stringify({ codex: "bypass", claude: "yolo", opencode: "__proto__" }),
    ),
  );
  await launchFixture(page);
  const mode = page.getByLabel("Startmodus", { exact: true });
  const cli = page.getByLabel("CLI", { exact: true });
  await expect(mode).toHaveValue("yolo");
  await cli.selectOption("claude");
  await expect(mode).toHaveValue("auto");
  await cli.selectOption("opencode");
  await expect(mode).toHaveValue("auto");
});

test("an unreadable launch-mode memory keeps the defaults", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("agentpier.launch-modes", "{"));
  await launchFixture(page);
  await expect(page.getByLabel("Startmodus", { exact: true })).toHaveValue("yolo");
});

test("a task profile keeps its own permission mode across a CLI round trip", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "agentpier.launch-modes",
      JSON.stringify({ codex: "default", claude: "bypass" }),
    ),
  );
  const profileLaunches = [];
  await page.route("**/api/pipeline-profiles", (route) =>
    route.fulfill({
      json: {
        profiles: [
          {
            id: "review",
            name: "Review",
            enabled: true,
            config: {
              accountId: "local-claude",
              cliTool: "claude",
              models: { available: [""], default: "" },
              prompts: { params: [] },
              permissions: { mode: "plan" },
            },
          },
        ],
      },
    }),
  );
  await page.route("**/api/pipeline-profiles/review/launch", (route) => {
    profileLaunches.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { error: "Profile launch captured" } });
  });
  await launchFixture(page);
  const mode = page.getByLabel("Startmodus", { exact: true });
  const cli = page.getByLabel("CLI", { exact: true });
  await page.getByLabel("Aufgabenprofil", { exact: true }).selectOption("review");
  await expect(mode).toHaveValue("profile");
  await cli.selectOption("codex");
  await expect(mode).toHaveValue("yolo");
  await cli.selectOption("claude");
  await expect(mode).toHaveValue("profile");
  await expect(page.locator(".launch-mode-remembered")).toHaveCount(0);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Session starten", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText("Profile launch captured");
  expect(profileLaunches).toHaveLength(1);
  expect(profileLaunches[0]).not.toHaveProperty("launchMode");
});

test("unattended modes carry a warning and say when memory preselected them", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("agentpier-language", "en");
    localStorage.setItem("agentpier.launch-modes", JSON.stringify({ claude: "bypass" }));
  });
  await launchFixture(page);
  const mode = page.getByLabel("Launch mode", { exact: true });
  const note = page.locator("#launch-mode-description");
  const remembered = "Preselected from your last session.";
  await expect(mode).toHaveValue("yolo");
  await expect(note).toHaveClass(/launch-mode-warning/);
  await expect(note).not.toContainText(remembered);
  await page.getByLabel("CLI", { exact: true }).selectOption("claude");
  await expect(mode).toHaveValue("bypass");
  await expect(note).toHaveClass(/launch-mode-warning/);
  await expect(note).toContainText(remembered);
  await expect(mode.locator('option[value="bypass"]')).toHaveText(
    "No permission prompts · no checks",
  );
  await mode.selectOption("auto");
  await expect(note).not.toHaveClass(/launch-mode-warning/);
  await expect(note).not.toContainText(remembered);
  await mode.selectOption("bypass");
  await expect(note).toHaveClass(/launch-mode-warning/);
  await expect(note).not.toContainText(remembered);
});
