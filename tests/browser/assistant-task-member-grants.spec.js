import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { settingsPath } from "../helpers/agent-settings-page.js";
import { chatAssistant } from "../helpers/assistant-chat-fixture.js";
import { fixture } from "./providers-fixture.js";
import { hubFixture } from "./projects-fixture.js";
import { bound } from "./mcp-cli-fixture.js";
import { agent, wizardSetup, withAgents } from "./mcp-wizard-fixture.js";

// A lead ("Home") granted its task-bound member Scout a project folder, an MCP
// server, shell and SSH, and Scout may request coding runs through Home
// (AGENTPIER-154): the owner sees each grant in Scout's Access tab, the
// project's Agents section and the MCP overview, marked as a task-bound member's,
// and revokes it there; coding through the lead is listed without Revoke.
const phone = { width: 390, height: 844 };
const fits = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const words = {
  en: {
    title: "Shared by the lead agent",
    folderSub: "via Home · Task-bound member · Folder: read",
    serverSub:
      "via Home · Task-bound member · Not in effect: the lead agent does not hold it right now",
    shellSub: "via Home · Task-bound member · Shell: With approval",
    codingSub:
      "via Home · Task-bound member · Coding runs through the lead agent · Comes with the task: each run waits for your approval. To end it, stop or archive the member.",
    revoke: "Revoke",
    revokeNow: "Revoke now",
    confirm: "waiting approvals for it are cancelled",
    projectSection: "Shared by lead agents",
    serverRow: "Scout · via Home · Task-bound member",
  },
  de: {
    title: "Vom leitenden Agenten geteilt",
    folderSub: "über Home · Auftragsgebundenes Mitglied · Ordner: lesen",
    serverSub:
      "über Home · Auftragsgebundenes Mitglied · Gerade ohne Wirkung: Der leitende Agent hat es zurzeit nicht",
    shellSub: "über Home · Auftragsgebundenes Mitglied · Shell: Mit Freigabe",
    codingSub:
      "über Home · Auftragsgebundenes Mitglied · Coding-Aufträge über den leitenden Agenten · Gehört zur Aufgabe: Jeder Auftrag wartet auf deine Freigabe. Zum Beenden stoppe oder archiviere das Mitglied.",
    revoke: "Widerrufen",
    revokeNow: "Jetzt widerrufen",
    confirm: "wartende Freigaben dafür werden abgebrochen",
    projectSection: "Von leitenden Agenten geteilt",
    serverRow: "Scout · über Home · Auftragsgebundenes Mitglied",
  },
};
const cases = [
  ["en", "desktop", null],
  ["en", "phone", phone],
  ["de", "desktop", null],
  ["de", "phone", phone],
];
const base = {
  temporary: true,
  leadId: "home",
  leadName: "Home",
  memberId: "scout",
  memberAssistantId: "scout",
  memberName: "Scout",
  requestId: null,
};
// As GET /api/assistant-lead-shares answers them (task-member-grants.js).
const grants = [
  {
    ...base,
    id: "task:scout:project:m1",
    kind: "project",
    revocable: true,
    projectId: "m1",
    projectName: "agent-pier",
    coding: false,
    folder: "write",
    live: { coding: false, folder: "read" },
  },
  {
    ...base,
    id: "task:scout:coding:m1",
    kind: "coding",
    revocable: false,
    projectId: "m1",
    projectName: "agent-pier",
    live: { coding: true },
  },
  {
    ...base,
    id: "task:scout:mcp:s1",
    kind: "mcp",
    revocable: true,
    serverId: "s1",
    serverName: "docs",
    live: { bound: false },
  },
  {
    ...base,
    id: "task:scout:shell",
    kind: "shell",
    revocable: true,
    shell: "approval",
    live: { shell: "approval" },
  },
];

function grantRoutes(list) {
  const state = { grants: structuredClone(list), deleted: [] };
  state.handle = async (route, url, method) => {
    if (!url.pathname.startsWith("/api/assistant-lead-shares")) return false;
    if (method === "DELETE") {
      const id = decodeURIComponent(url.pathname.split("/").at(-1));
      state.deleted.push(id);
      state.grants = state.grants.filter((g) => g.id !== id);
      await route.fulfill({ json: { removed: id, kind: "project", pending: false } });
      return true;
    }
    await route.fulfill({ json: { shares: [], memberGrants: state.grants } });
    return true;
  };
  return state;
}

async function revoke(page, scope, language) {
  const w = words[language];
  await scope
    .getByRole("button", { name: new RegExp(w.revoke, "i") })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(w.confirm, { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: w.revokeNow }).click();
  await expect(dialog).toHaveCount(0);
}

for (const [language, label, viewport] of cases) {
  test.describe(`${language} ${label}`, () => {
    if (language === "en") test.use({ locale: "en-GB" });
    if (viewport) test.use({ viewport });
    const w = words[language];

    test("a task member's Access tab lists its lead's grants and the owner revokes one", async ({
      page,
    }) => {
      await fixture(page);
      await page.addInitScript(
        (value) => localStorage.setItem("agentpier-language", value),
        language,
      );
      const state = grantRoutes(grants);
      await page.route(/\/api\/assistant/, async (route) => {
        if (await fulfillEnabledAssistantFeature(route)) return;
        const url = new URL(route.request().url());
        if (await state.handle(route, url, route.request().method())) return;
        let body;
        if (url.pathname === "/api/assistants")
          body = {
            assistants: [
              chatAssistant({ id: "home", name: "Home" }),
              chatAssistant({
                id: "scout",
                name: "Scout",
                teamMemberId: "scout",
                teamId: "t1",
                parentAssistantId: "home",
                lifetime: "task",
                inherited: {
                  capabilities: { memory: true },
                  skills: [],
                  shell: "approval",
                  ssh: false,
                  projects: { m1: "read" },
                },
              }),
            ],
            conversations: [],
            models: [{ id: "router", name: "Router", available: true }],
          };
        else if (url.pathname === "/api/assistant-runtime")
          body = { availability: "ready", sync: "current" };
        else if (url.pathname === "/api/assistant-events")
          return route.fulfill({
            contentType: "text/event-stream",
            body: 'data: {"type":"connected"}\n\n',
          });
        else return route.fallback();
        await route.fulfill({ json: body });
      });
      await page.goto(baseURL + settingsPath("access", undefined, "scout"));
      const group = page.locator("#agent-lead-shares");
      await expect(group.getByRole("heading", { name: w.title })).toBeVisible();
      for (const sub of [w.folderSub, w.serverSub, w.shellSub, w.codingSub])
        await expect(group.getByText(sub, { exact: true })).toBeVisible();
      // Coding through the lead has no Revoke of its own.
      await expect(
        group.getByRole("button", { name: new RegExp(w.revoke, "i") }),
      ).toHaveCount(3);
      expect(await fits(page)).toBe(true);
      await revoke(page, group.locator(".lead-share-row").first(), language);
      expect(state.deleted).toEqual(["task:scout:project:m1"]);
      await expect(group.getByText(w.folderSub, { exact: true })).toHaveCount(0);
      await expect(group.getByText(w.shellSub, { exact: true })).toBeVisible();
    });

    test("a project's Agents section lists a task member's folder and revokes it", async ({
      page,
    }) => {
      const state = grantRoutes(grants);
      await hubFixture(page, {
        intercept: async (route, url, method) => {
          if (url.pathname === "/api/assistant-project-access/m1") {
            await route.fulfill({
              json: {
                agents: [],
                members: [],
                shared: [],
                memberGrants: state.grants
                  .filter((g) => g.projectId === "m1")
                  .map((g) => ({
                    id: g.id,
                    kind: g.kind,
                    revocable: g.revocable,
                    agentId: g.memberAssistantId,
                    name: g.memberName,
                    leadId: g.leadId,
                    leadName: g.leadName,
                    folder: g.live.folder || "none",
                    coding: g.live.coding,
                  })),
              },
            });
            return true;
          }
          return state.handle(route, url, method);
        },
      });
      if (language === "en")
        await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
      await page.goto(baseURL + "/projects/m1?tab=agents");
      const section = page.locator("[data-project-shared]");
      await expect(
        section.getByRole("heading", { name: w.projectSection }),
      ).toBeVisible();
      await expect(section.getByText(w.folderSub, { exact: true })).toBeVisible();
      await expect(section.getByText(w.codingSub, { exact: true })).toBeVisible();
      expect(await fits(page)).toBe(true);
      await revoke(page, section, language);
      expect(state.deleted).toEqual(["task:scout:project:m1"]);
      await expect(section.getByText(w.folderSub, { exact: true })).toHaveCount(0);
      await expect(section.getByText(w.codingSub, { exact: true })).toBeVisible();
    });
  });
}

for (const [language, viewport] of [
  ["en", null],
  ["en", phone],
  ["de", null],
  ["de", phone],
]) {
  test(`the MCP overview names task members using a server through their lead (${language}${viewport ? ", phone" : ""})`, async ({
    page,
  }) => {
    if (viewport) await page.setViewportSize(viewport);
    const w = words[language];
    const server = bound({
      memberGrants: [
        {
          id: "task:scout:mcp:s1",
          agentId: "scout",
          agentName: "Scout",
          leadId: "home",
          leadName: "Home",
          bound: true,
        },
      ],
    });
    const state = await wizardSetup(page, { servers: [server], agents: true, language });
    await withAgents(page, state, [agent("home", "Home", { mcpServers: ["s1"] })]);
    const routes = grantRoutes(grants.filter((g) => g.kind === "mcp"));
    await page.route(/\/api\/assistant-lead-shares/, async (route) => {
      const url = new URL(route.request().url());
      await routes.handle(route, url, route.request().method());
      // The overview reads the list again: the grant is gone.
      state.servers[0].memberGrants = [];
    });
    await page.goto(`${baseURL}/accounts?section=mcp-servers&item=s1`);
    const shared = page.locator("[data-mcp-shared='s1']");
    await expect(shared.getByText(w.serverRow, { exact: true })).toBeVisible();
    expect(await fits(page)).toBe(true);
    await revoke(page, shared, language);
    expect(routes.deleted).toEqual(["task:scout:mcp:s1"]);
    await expect(shared).toHaveCount(0);
  });
}
