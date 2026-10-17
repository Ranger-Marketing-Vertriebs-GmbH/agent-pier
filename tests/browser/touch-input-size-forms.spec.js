import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { createApplication } from "../../server/app.js";
import { baseURL } from "../helpers/browser.js";
import { openNewSession } from "../helpers/navigation.js";
import { setupAssistantSettings } from "../helpers/assistant-settings-browser.js";
import { settingsPath } from "../helpers/agent-settings-page.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { explorerFixture } from "../helpers/file-explorer-browser.js";
import { extensionsPageFixture } from "../helpers/extensions-page-fixture.js";
import { fulfillDormantAssistantRequest } from "../helpers/assistant-browser-fixture.js";
import { expectTouchSized, phone } from "./touch-input-size.js";
import { setup as teamSetup } from "./assistant-teams-fixture.js";
import { fixture as sshFixture } from "./ssh-fixture.js";
import { fixture as providersFixture, createForm } from "./providers-fixture.js";
import { operationsFixture } from "./operations-fixture.js";
import { notifications } from "./notifications-fixture.js";
import { pipelinesFixture, openPipelines } from "./pipelines-fixture.js";
import { wizardSetup, openWizard, chooseSource } from "./mcp-wizard-fixture.js";
import { hubFixture } from "./projects-fixture.js";
import { artifactsFixture } from "./artifacts-fixture.js";

// Dialogs and forms that need data: each step checks the controls it shows.
test.use(phone);

test("login setup and sign-in forms", async ({ page, context }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-touch-login-"));
  const application = await createApplication({ dataDir: root, home: root, port: 0 });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${application.server.address().port}`;
  try {
    await context.clearCookies();
    await page.goto(url + "/settings");
    await expect(page.getByRole("heading", { name: "Benutzer erstellen" })).toBeVisible();
    await expectTouchSized(page, "login setup");
    await application.login.setup({ username: "owner", password: "disposable-password" });
    await page.goto(url);
    await expect(
      page.getByRole("button", { name: "Anmelden", exact: true }),
    ).toBeVisible();
    await expectTouchSized(page, "login");
  } finally {
    await application.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("new session dialog", async ({ page }) => {
  await sshFixture(page);
  await page.route("**/api/pipeline-profiles", (route) =>
    route.fulfill({ json: { profiles: [] } }),
  );
  await page.goto("/");
  await openNewSession(page);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expectTouchSized(page, "new session");
});

test("session chat composer", async ({ page }) => {
  const session = {
    id: "touch",
    accountId: "fixture",
    tool: "codex",
    cwd: "/fixture",
    status: "running",
    name: "Touch session",
  };
  const data = { availability: "ready", messages: [], tasks: [] };
  await mockChatStream(page, () => data);
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let json = {};
    if (pathname === "/api/state")
      json = {
        sessions: [session],
        accounts: [],
        tools: [{ id: "codex", name: "Codex", installed: true }],
        home: "/fixture",
      };
    if (pathname.endsWith("/chat")) json = data;
    return route.fulfill({ json });
  });
  await page.goto(baseURL + "/sessions/touch/chat");
  await expect(page.locator(".chat-composer textarea")).toBeVisible();
  await expectTouchSized(page, "session chat");
});

test("agent settings tabs and team limits", async ({ page }) => {
  await setupAssistantSettings(page);
  for (const tab of ["profile", "capabilities", "work", "telegram"]) {
    await page.goto(baseURL + settingsPath(tab));
    await expect(page.getByRole("tab", { selected: true })).toBeVisible();
    await expectTouchSized(page, `agent settings ${tab}`);
  }
  for (const subpage of ["memory", "allowlist", "skills", "actions", "projects", "ssh"]) {
    await page.goto(baseURL + settingsPath(undefined, subpage));
    await expect(page.getByRole("tab", { selected: true })).toBeVisible();
    await expectTouchSized(page, `agent settings ${subpage}`);
  }
});

test("agent work tab team limits", async ({ page }) => {
  await teamSetup(page);
  await page.goto(baseURL + settingsPath("work"));
  await expect(page.getByRole("spinbutton", { name: "Maximum team size" })).toBeVisible();
  await expectTouchSized(page, "agent work team");
});

test("agent chat composer", async ({ page }) => {
  await chatFixture(page);
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.locator(".assistant-composer textarea")).toBeVisible();
  await expectTouchSized(page, "agent chat");
});

test("model connection form and anchored select search", async ({ page }) => {
  const controls = await providersFixture(page);
  await createForm(page, "opencode", controls);
  await expectTouchSized(page, "connection form");
  await page.getByLabel("API-Anbieter", { exact: true }).selectOption("openrouter");
  await page.getByLabel("Anbietermodell", { exact: true }).tap();
  await expect(page.getByRole("combobox", { name: "Modelle suchen" })).toBeVisible();
  await expectTouchSized(page, "anchored select search");
});

test("backup and restore dialogs", async ({ page }) => {
  await operationsFixture(page);
  await page.goto(baseURL + "/settings/backups");
  await page.getByRole("button", { name: "Sicherung vorbereiten", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expectTouchSized(page, "backup dialog");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Sicherung prüfen und wiederherstellen", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expectTouchSized(page, "restore dialog");
});

test("SSH access form", async ({ page }) => {
  await sshFixture(page);
  await page.goto(baseURL + "/settings/ssh");
  await expectTouchSized(page, "ssh list");
  await page.getByRole("button", { name: "Zugang hinzufügen", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expectTouchSized(page, "ssh dialog");
});

test("notification devices", async ({ page }) => {
  await notifications(page);
  await page.goto(baseURL + "/settings/notifications");
  await page.waitForTimeout(1000);
  await expectTouchSized(page, "notifications");
});

test("pipeline definitions, profiles and runs", async ({ page }) => {
  await pipelinesFixture(page);
  for (const item of [
    "runs",
    "definitions",
    "definitions/pipeline-one",
    "profiles",
    "profiles/new",
    "profiles/profile-one",
  ]) {
    await openPipelines(page, item);
    await page.waitForTimeout(500);
    await expectTouchSized(page, `pipelines ${item}`);
  }
  await openPipelines(page, "definitions/pipeline-one");
  await page.getByRole("button", { name: "Stufe hinzufügen", exact: true }).click();
  await expectTouchSized(page, "pipelines stage");
});

test("MCP wizard steps", async ({ page }) => {
  await wizardSetup(page);
  for (const source of [
    "Server on the internet",
    "Own command",
    "Package from npm or PyPI",
  ]) {
    const wizard = await openWizard(page);
    await expectTouchSized(page, "mcp wizard source");
    await chooseSource(wizard, source);
    await page.waitForTimeout(500);
    await expectTouchSized(page, `mcp wizard ${source}`);
  }
});

test("projects, search and knowledge", async ({ page }) => {
  await hubFixture(page);
  await page.goto(baseURL + "/repositories");
  await page.waitForTimeout(500);
  await expectTouchSized(page, "projects");
  for (const tab of ["knowledge", "agentbus", "runs"]) {
    await page.goto(baseURL + `/projects/r1?tab=${tab}`);
    await page.waitForTimeout(500);
    await expectTouchSized(page, `project ${tab}`);
  }
});

test("knowledge editor and forget dialog", async ({ page }) => {
  const project = {
    id: "project-one",
    name: "AgentPier",
    cwd: "/workspace/agentpier",
    kind: "repository",
    entryCount: 1,
  };
  const entry = {
    id: "note-one",
    projectId: project.id,
    title: "Deploy notes",
    content: "Use the release script",
    revision: 2,
    archived: false,
    createdAt: "2026-09-07T00:00:00Z",
    updatedAt: "2026-09-07T00:00:00Z",
    provenance: { kind: "user" },
  };
  await page.route("**/api/**", async (route) => {
    if (await fulfillDormantAssistantRequest(route)) return;
    const pathname = new URL(route.request().url()).pathname;
    let json = {};
    if (pathname === "/api/state")
      json = { tools: [], accounts: [], sessions: [], home: "/workspace" };
    else if (pathname === "/api/repositories") json = { credentials: [], projects: [] };
    else if (pathname === "/api/agentbus") json = { version: "test", projects: [] };
    else if (pathname === "/api/pipeline-runs")
      json = { runs: [], total: 0, page: 1, pageSize: 20 };
    else if (pathname === "/api/memory/projects") json = { projects: [project] };
    else if (pathname === "/api/memory/migration-backups") json = { count: 1 };
    else if (pathname.endsWith("/entries"))
      json = { projectId: project.id, items: [entry], page: 1, pageSize: 20, total: 1 };
    await route.fulfill({ json });
  });
  await page.goto(baseURL + "/projects/project-one?tab=knowledge");
  await page.getByRole("button", { name: "Deploy notes", exact: true }).click();
  await expectTouchSized(page, "knowledge entry");
  await page.getByRole("button", { name: "Bearbeiten: Deploy notes" }).click();
  await expectTouchSized(page, "knowledge editor");
  await page.goto(baseURL + "/projects/project-one?tab=knowledge");
  await page.getByRole("button", { name: "Neuer Eintrag" }).click();
  await expectTouchSized(page, "knowledge new entry");
  await page.goto(baseURL + "/projects/project-one?tab=knowledge");
  await page.getByRole("button", { name: "Deploy notes", exact: true }).click();
  await page.getByRole("button", { name: /^Endgültig vergessen: Deploy notes/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expectTouchSized(page, "knowledge forget");
});

test("files and their search", async ({ page }) => {
  await explorerFixture(page);
  await page.goto(baseURL + "/files?path=%2Fhome%2Ftest");
  await page.waitForTimeout(500);
  await expectTouchSized(page, "files");
  await page.locator(".explorer-search-options > summary").click();
  await expectTouchSized(page, "files search options");
});

test("artifacts", async ({ page, context }) => {
  await artifactsFixture(context, { language: "en" });
  await page.goto(baseURL + "/artifacts");
  await page.waitForTimeout(500);
  await expectTouchSized(page, "artifacts");
});

test("extensions and skills", async ({ page }) => {
  await extensionsPageFixture(page);
  for (const path of ["/extensions", "/extensions?tab=skills", "/plugins"]) {
    await page.goto(baseURL + path);
    await page.waitForTimeout(500);
    await expectTouchSized(page, `extensions ${path}`);
  }
});
