import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { settingsPath } from "../helpers/agent-settings-page.js";
import { chatAssistant, chatFixture } from "../helpers/assistant-chat-fixture.js";
import { fixture } from "./providers-fixture.js";
import { hubFixture } from "./projects-fixture.js";
import { bound } from "./mcp-cli-fixture.js";
import { agent, wizardSetup, withAgents } from "./mcp-wizard-fixture.js";

// A lead ("Home") shares its own access with its permanent member Scout
// (AGENTPIER-153): the owner sees each share in Scout's settings, the project's
// Agents section and the MCP overview, and revokes it; a routine may be marked to
// delegate writing tasks; a refused change on a member's result offers a go-ahead.
const phone = { width: 390, height: 844 };
const fits = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const words = {
  en: {
    title: "Shared by the lead agent",
    projectSub: "via Home · Folder: read and write · Coding · Standing",
    serverSub: "via Home · Standing",
    revoke: "Revoke",
    revokeNow: "Revoke now",
    projectSection: "Shared by lead agents",
    delegate: "May delegate writing tasks",
    goAhead: "Go ahead",
    goAheadText: "Yes, go ahead",
  },
  de: {
    title: "Vom leitenden Agenten geteilt",
    projectSub: "über Home · Ordner: lesen und ändern · Coding · Dauerhaft",
    serverSub: "über Home · Dauerhaft",
    revoke: "Widerrufen",
    revokeNow: "Jetzt widerrufen",
    projectSection: "Von leitenden Agenten geteilt",
    delegate: "Darf schreibende Aufgaben delegieren",
    goAhead: "Direkt umsetzen",
    goAheadText: "Ja, direkt umsetzen",
  },
};
const cases = [
  ["en", "desktop", null],
  ["en", "phone", phone],
  ["de", "desktop", null],
  ["de", "phone", phone],
];
const projectShare = {
  id: "share-p",
  kind: "project",
  leadId: "home",
  leadName: "Home",
  memberAssistantId: "scout",
  memberName: "Scout",
  requestId: null,
  projectId: "m1",
  projectName: "agent-pier",
  coding: true,
  folder: "write",
  live: { coding: true, folder: "write" },
};
const serverShare = {
  id: "share-s",
  kind: "mcp",
  leadId: "home",
  leadName: "Home",
  memberAssistantId: "scout",
  memberName: "Scout",
  requestId: null,
  serverId: "s1",
  serverName: "docs",
  live: { bound: true },
};

// The lead-share routes as the server answers them (assistant-lead-shares.js).
function shareRoutes(shares) {
  const state = { shares: structuredClone(shares), deleted: [] };
  state.handle = async (route, url, method) => {
    if (!url.pathname.startsWith("/api/assistant-lead-shares")) return false;
    if (method === "DELETE") {
      const id = decodeURIComponent(url.pathname.split("/").at(-1));
      state.deleted.push(id);
      state.shares = state.shares.filter((s) => s.id !== id);
      await route.fulfill({ json: { removed: id, pending: false } });
      return true;
    }
    const memberId = url.searchParams.get("memberId");
    await route.fulfill({
      json: {
        shares: state.shares.filter((s) => !memberId || s.memberAssistantId === memberId),
      },
    });
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
  await dialog.getByRole("button", { name: w.revokeNow }).click();
  await expect(dialog).toHaveCount(0);
}

for (const [language, label, viewport] of cases) {
  test.describe(`${language} ${label}`, () => {
    if (language === "en") test.use({ locale: "en-GB" });
    if (viewport) test.use({ viewport });
    const w = words[language];

    test("the member's settings list what its lead shares and the owner revokes one", async ({
      page,
    }) => {
      await fixture(page);
      await page.addInitScript(
        (value) => localStorage.setItem("agentpier-language", value),
        language,
      );
      const shares = shareRoutes([projectShare, serverShare]);
      await page.route(/\/api\/assistant/, async (route) => {
        if (await fulfillEnabledAssistantFeature(route)) return;
        const url = new URL(route.request().url());
        if (await shares.handle(route, url, route.request().method())) return;
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
                lifetime: "permanent",
              }),
            ],
            conversations: [],
            models: [{ id: "router", name: "Router", available: true }],
          };
        else if (url.pathname === "/api/assistant-runtime")
          body = { availability: "ready", sync: "current" };
        else if (url.pathname === "/api/assistant-workspace-catalog")
          body = { projects: [], pipelines: [], sshHosts: [] };
        else if (url.pathname.endsWith("/access"))
          body = {
            revision: 0,
            projectIds: [],
            projectFiles: {},
            pipelineIds: [],
            memoryWrite: false,
            autonomous: false,
            publish: false,
            sshAccesses: [],
          };
        else if (url.pathname.endsWith("/actions")) body = { actions: [] };
        else if (url.pathname === "/api/assistant-events")
          return route.fulfill({
            contentType: "text/event-stream",
            body: 'data: {"type":"connected"}\n\n',
          });
        else return route.fallback();
        await route.fulfill({ json: body });
      });
      await page.goto(baseURL + settingsPath("work", undefined, "scout"));
      const group = page.locator("#agent-lead-shares");
      await expect(group.getByRole("heading", { name: w.title })).toBeVisible();
      await expect(group.getByText(w.projectSub, { exact: true })).toBeVisible();
      await expect(group.getByText(w.serverSub, { exact: true })).toBeVisible();
      expect(await fits(page)).toBe(true);
      await revoke(page, group.locator(".lead-share-row").first(), language);
      expect(shares.deleted).toEqual(["share-p"]);
      await expect(group.getByText(w.projectSub, { exact: true })).toHaveCount(0);
      await expect(group.getByText(w.serverSub, { exact: true })).toBeVisible();
    });

    test("a project's Agents section shows shares via the lead and revokes one", async ({
      page,
    }) => {
      const shares = shareRoutes([projectShare]);
      await hubFixture(page, {
        intercept: async (route, url, method) => {
          if (url.pathname === "/api/assistant-project-access/m1") {
            await route.fulfill({
              json: {
                agents: [],
                members: [],
                shared: shares.shares.map((s) => ({
                  id: s.id,
                  agentId: s.memberAssistantId,
                  name: s.memberName,
                  leadId: s.leadId,
                  leadName: s.leadName,
                  requestId: s.requestId,
                  coding: s.live.coding,
                  folder: s.live.folder,
                })),
              },
            });
            return true;
          }
          return shares.handle(route, url, method);
        },
      });
      if (language === "en")
        await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
      await page.goto(baseURL + "/projects/m1?tab=agents");
      const section = page.locator("[data-project-shared]");
      await expect(
        section.getByRole("heading", { name: w.projectSection }),
      ).toBeVisible();
      await expect(section.getByText("Scout", { exact: true })).toBeVisible();
      await expect(section.getByText(w.projectSub, { exact: true })).toBeVisible();
      expect(await fits(page)).toBe(true);
      await revoke(page, section, language);
      expect(shares.deleted).toEqual(["share-p"]);
      await expect(section).toHaveCount(0);
    });

    test("the owner marks a routine as one that may delegate writing tasks", async ({
      page,
    }) => {
      await fixture(page);
      await page.addInitScript(
        (value) => localStorage.setItem("agentpier-language", value),
        language,
      );
      const routine = {
        id: "r1",
        name: "Nightly render",
        prompt: "Render the site.",
        trigger: { kind: "cron", expr: "0 2 * * *", tz: "Europe/Berlin" },
        status: "ready",
        enabled: true,
        revision: 1,
        delegateWrites: false,
      };
      const patches = [];
      await page.route(/\/api\/assistant/, async (route) => {
        if (await fulfillEnabledAssistantFeature(route)) return;
        const path = new URL(route.request().url()).pathname,
          method = route.request().method();
        let body;
        if (path === "/api/assistants")
          body = {
            assistants: [
              chatAssistant({
                id: "home",
                name: "Home",
                capabilities: { reminders: true, memory: false },
              }),
            ],
            conversations: [],
            models: [{ id: "router", name: "Router", available: true }],
          };
        else if (path === "/api/assistant-runtime")
          body = { availability: "ready", sync: "current" };
        else if (path === "/api/assistant-events")
          return route.fulfill({
            contentType: "text/event-stream",
            body: 'data: {"type":"connected"}\n\n',
          });
        else if (path === "/api/assistant-channels") body = { channels: [] };
        else if (path.endsWith("/routines")) body = { routines: [routine] };
        else if (path.endsWith("/routines/r1") && method === "PATCH") {
          const input = route.request().postDataJSON();
          patches.push(input);
          Object.assign(routine, input, { revision: routine.revision + 1 });
          body = routine;
        } else if (path.endsWith("/reminders")) body = { reminders: [] };
        else body = {};
        await route.fulfill({ json: body });
      });
      await page.goto(baseURL + settingsPath("routines"));
      await page.getByRole("button", { name: /Nightly render/ }).click();
      const toggle = page.getByRole("switch", { name: w.delegate });
      await expect(toggle).not.toBeChecked();
      await toggle.click();
      await expect.poll(() => patches.length).toBe(1);
      expect(patches[0]).toEqual({ delegateWrites: true, revision: 1 });
      await expect(toggle).toBeChecked();
      expect(await fits(page)).toBe(true);
    });

    test("a refused change on a member's result offers the owner a go-ahead", async ({
      page,
    }) => {
      const history = (goAhead) => ({
        messages: [
          { id: "q", role: "user", text: "Render the site with Scout." },
          { id: "result", role: "event", event: "member-result", timestamp: 2 },
          {
            id: "reply",
            role: "assistant",
            text: "Scout rendered it. Shall I copy the result into the project?",
          },
        ],
        requests: [
          {
            id: "follow-up",
            internal: "member-result",
            ...(goAhead ? { goAhead: true } : {}),
            attempt: { id: "a1", state: "completed" },
          },
        ],
        stale: false,
      });
      const state = await chatFixture(page, { language, history: history(true) });
      await page.goto(baseURL + "/agents/home/chats/dinner");
      const button = page.getByRole("button", { name: w.goAhead, exact: true });
      await expect(button).toBeVisible();
      expect(await fits(page)).toBe(true);
      await button.click();
      await expect.poll(() => state.posted.length).toBe(1);
      expect(state.posted[0].text).toBe(w.goAheadText);
      expect(state.posted[0].clientRequestId).toBeTruthy();
    });
  });
}

test("no go-ahead without the server's mark", async ({ page }) => {
  await chatFixture(page, {
    history: {
      messages: [{ id: "reply", role: "assistant", text: "Done." }],
      requests: [
        {
          id: "follow-up",
          internal: "member-result",
          attempt: { id: "a1", state: "completed" },
        },
      ],
      stale: false,
    },
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.getByText("Done.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Go ahead", exact: true })).toHaveCount(
    0,
  );
});

for (const [language, viewport] of [
  ["en", null],
  ["en", phone],
  ["de", null],
]) {
  test(`the MCP overview names members using a server through their lead (${language}${viewport ? ", phone" : ""})`, async ({
    page,
  }) => {
    if (viewport) await page.setViewportSize(viewport);
    const server = bound({
      shared: [
        {
          id: "share-s",
          agentId: "scout",
          agentName: "Scout",
          leadId: "home",
          leadName: "Home",
          requestId: null,
          bound: true,
        },
      ],
    });
    const state = await wizardSetup(page, { servers: [server], agents: true, language });
    await withAgents(page, state, [agent("home", "Home", { mcpServers: ["s1"] })]);
    const shares = shareRoutes([serverShare]);
    await page.route(/\/api\/assistant-lead-shares/, async (route) => {
      const url = new URL(route.request().url());
      await shares.handle(route, url, route.request().method());
      // The overview reads the list again: the share is gone.
      state.servers[0].shared = [];
    });
    await page.goto(`${baseURL}/accounts?section=mcp-servers&item=s1`);
    const shared = page.locator("[data-mcp-shared='s1']");
    await expect(
      shared.getByText(`Scout · ${language === "en" ? "via" : "über"} Home`),
    ).toBeVisible();
    expect(await fits(page)).toBe(true);
    await revoke(page, shared, language);
    expect(shares.deleted).toEqual(["share-s"]);
    await expect(shared).toHaveCount(0);
  });
}
