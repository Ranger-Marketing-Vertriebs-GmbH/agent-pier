import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { agentTab, saveBar, settingsPath } from "../helpers/agent-settings-page.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

const none = { bins: [], anyBins: [], env: [], config: [], os: [] };
const profile = {
  id: "home",
  name: "Home",
  instructions: "Plan meals",
  revision: 1,
  effectiveRevision: 1,
  model: { connectionId: "router", modelId: "model" },
  capabilities: { memory: false, reminders: false },
};
// What GET /api/assistants/:id/skills answers (server/features/assistants/agent-skills.js).
const catalog = (on = []) => ({
  assigned: on,
  shell: "off",
  skills: [
    {
      name: "clawhub",
      description: "Search and install skills from ClawHub.",
      state: "ready",
      missing: none,
      usesShell: false,
      risk: "installsCode",
    },
    {
      name: "github",
      emoji: "🐙",
      description: "Work with GitHub through the gh CLI.",
      state: "ready",
      missing: none,
      usesShell: true,
    },
    {
      name: "himalaya",
      description: "Read and send mail over IMAP and SMTP.",
      state: "missing",
      missing: { ...none, bins: ["himalaya"] },
      usesShell: true,
    },
    {
      name: "tmux",
      description: "",
      state: "shadowed",
      missing: none,
      usesShell: false,
    },
  ].map((skill) => ({
    ...skill,
    assigned: on.includes(skill.name),
    active: on.includes(skill.name) && skill.state === "ready",
  })),
});

async function setup(page, { language = "en", unavailable = false } = {}) {
  await fixture(page);
  await page.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  const state = { agent: { ...profile }, patches: [] };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    if (path === "/api/assistants/home/skills")
      return unavailable
        ? route.fulfill({
            status: 503,
            json: { code: "unavailable", error: "The agent service is not ready." },
          })
        : route.fulfill({ json: catalog(state.agent.skills || []) });
    if (path === "/api/assistants/home" && method === "PATCH") {
      const body = request.postDataJSON();
      state.patches.push(body);
      state.agent = {
        ...state.agent,
        ...(body.skills ? { skills: body.skills } : {}),
        revision: state.agent.revision + 1,
      };
      return route.fulfill({ json: state.agent });
    }
    if (path === "/api/assistants/home/shell-allowlist")
      return route.fulfill({ json: { entries: [] } });
    if (path === "/api/assistants")
      return route.fulfill({
        json: {
          assistants: [state.agent],
          conversations: [{ id: "chat", assistantId: "home" }],
          models: [{ id: "router", name: "Router", available: true }],
        },
      });
    if (path === "/api/assistant-runtime")
      return route.fulfill({ json: { availability: "ready", sync: "current" } });
    if (path === "/api/assistant-web-search")
      return route.fulfill({
        json: { revision: 0, provider: "duckduckgo", ready: true },
      });
    if (path.endsWith("/messages"))
      return route.fulfill({ json: { messages: [], requests: [], stale: false } });
    if (path === "/api/assistant-channels")
      return route.fulfill({ json: { channels: [] } });
    return route.fulfill({ json: {} });
  });
  return state;
}

const copy = {
  en: {
    row: /^Bundled skills/,
    none: "0 on",
    one: "1 on",
    shellOff: "Most skills run command-line programs and need shell access.",
    missing: "Missing: programs himalaya",
    needsShell: "Needs shell access",
    risk: "Warning: this skill can install code from outside",
    shadowed: "Off for this agent: a skill of the same name",
    search: "Search skills",
    filter: "Show",
    ready: "Ready",
    unsaved: "Unsaved changes",
    save: "Save agent",
    unavailable: "Skills can be listed while the agent service runs.",
  },
  de: {
    row: /^Mitgelieferte Skills/,
    none: "0 an",
    one: "1 an",
    shellOff:
      "Die meisten Skills führen Kommandozeilenprogramme aus und brauchen Shell-Zugriff.",
    missing: "Fehlt: Programme himalaya",
    needsShell: "Braucht Shell-Zugriff",
    risk: "Achtung: Dieser Skill kann fremden Code installieren",
    shadowed: "Für diesen Agenten aus: Ein gleichnamiger Skill",
    search: "Skills suchen",
    filter: "Anzeigen",
    ready: "Bereit",
    unsaved: "Ungespeicherte Änderungen",
    save: "Agent speichern",
    unavailable: "Skills lassen sich anzeigen, solange der Agentendienst läuft.",
  },
};
const group = (page) => page.locator("#agent-skills");
const subpage = (page) => page.locator("#agent-skills-page");

async function fitsPhone(page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
}

for (const language of ["en", "de"])
  for (const [label, use] of [
    ["desktop", {}],
    ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
  ])
    test.describe(`${language} ${label}`, () => {
      test.use(use);
      const t = copy[language];

      test("skills are switched on in a subpage and saved with the tab", async ({
        page,
      }) => {
        const state = await setup(page, { language });
        await page.goto(baseURL + settingsPath("capabilities"));
        await expect(group(page)).toContainText(t.none);
        await expect(group(page)).not.toContainText(t.shellOff);
        await group(page).getByRole("link", { name: t.row }).click();
        await expect(page).toHaveURL(/page=skills/);
        await expect(subpage(page)).toContainText(t.shellOff);
        await expect(subpage(page).locator(".toggle-row")).toHaveCount(4);
        const himalaya = subpage(page).locator(".toggle-row", { hasText: "himalaya" });
        await expect(himalaya).toContainText(t.missing);
        await expect(himalaya).toContainText(t.needsShell);
        const clawhub = subpage(page).locator(".toggle-row", { hasText: "clawhub" });
        await expect(clawhub).toContainText(t.risk);
        const tmux = subpage(page).locator(".toggle-row", { hasText: "tmux" });
        await expect(tmux).toContainText(t.shadowed);
        await expect(tmux.getByRole("switch")).toBeDisabled();
        if (label === "phone") await fitsPhone(page);

        // Search and filter narrow the list.
        await subpage(page).getByRole("searchbox", { name: t.search }).fill("mail");
        await expect(subpage(page).locator(".toggle-row")).toHaveCount(1);
        await subpage(page).getByRole("searchbox", { name: t.search }).fill("");
        await subpage(page)
          .getByRole("combobox", { name: t.filter })
          .selectOption({ label: t.ready });
        await expect(subpage(page).locator(".toggle-row")).toHaveCount(2);
        await subpage(page).getByRole("combobox", { name: t.filter }).selectOption("all");

        // A switch edits the tab's draft; the save bar stores it in one PATCH.
        const github = subpage(page).locator(".toggle-row", {
          hasText: "Work with GitHub",
        });
        // The emoji is decoration: the switch is named by the skill alone.
        await expect(
          subpage(page).getByRole("switch", { name: "github", exact: true }),
        ).toHaveCount(1);
        await github.getByRole("switch").check();
        await saveBar(page, t.unsaved).getByRole("button", { name: t.save }).click();
        await expect(saveBar(page, t.unsaved)).toHaveCount(0);
        expect(state.patches).toEqual([{ skills: ["github"], revision: 1 }]);
        await expect(github.getByRole("switch")).toBeChecked();
        await subpage(page).locator(".agent-subpage-back").click();
        await expect(group(page)).toContainText(t.one);
        await expect(group(page)).toContainText(t.shellOff);
        if (label === "phone") await fitsPhone(page);
      });

      test("the page says when the agent service is not running", async ({ page }) => {
        const state = await setup(page, { language, unavailable: true });
        state.agent.skills = ["github"];
        await page.goto(baseURL + settingsPath("capabilities", "skills"));
        await expect(subpage(page)).toContainText(t.unavailable);
        // A switched-on skill can still be switched off without the service.
        const github = subpage(page).getByRole("switch", { name: "github" });
        await expect(github).toBeChecked();
        await github.uncheck();
        await saveBar(page, t.unsaved).getByRole("button", { name: t.save }).click();
        await expect(saveBar(page, t.unsaved)).toHaveCount(0);
        expect(state.patches).toEqual([{ skills: [], revision: 1 }]);
      });
    });

test("the Capabilities tab leads to the skills group", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/agents/home/settings");
  await agentTab(page, "Capabilities").click();
  await expect(
    group(page).getByRole("heading", { name: "Skills", exact: true }),
  ).toBeVisible();
});

test("temporary members have no skills", async ({ page }) => {
  const state = await setup(page);
  state.agent.teamMemberId = "member";
  state.agent.lifetime = "temporary";
  await page.goto(baseURL + settingsPath("capabilities", "skills"));
  await expect(page).not.toHaveURL(/page=skills/);
  await expect(group(page)).toHaveCount(0);
});
