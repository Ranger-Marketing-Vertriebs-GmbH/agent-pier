import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

test.use({ locale: "en-GB" });

const none = { bins: [], anyBins: [], env: [], config: [], os: [] };
const agent = {
  id: "home",
  name: "Home",
  instructions: "Plan meals",
  revision: 1,
  effectiveRevision: 1,
  model: { connectionId: "router", modelId: "model" },
  capabilities: { memory: false, reminders: false },
};
// A GitHub skill already in the catalog, whose source has not changed.
const githubSkill = {
  id: "gh-1",
  name: "gh-notes",
  description: "Notes from GitHub issues.",
  version: 3,
  importKind: "github",
  origin: {
    kind: "github",
    repository: "acme/skills",
    refKind: "branch",
    ref: "main",
    commit: "0123456789abcdef0123",
  },
  repository: true,
  scan: { verdict: "ok", rules: [], overridden: false },
  needsSettings: false,
  state: "ready",
  requirements: { bins: ["gh"], anyBins: ["jq", "yq"] },
};
const warning = {
  rule: "prompt-injection",
  severity: "warn",
  file: "SKILL.md",
  line: 4,
  excerpt: "Ignore previous instructions.",
};
const preview = (state, extra = {}) => ({
  previewId: `preview-${++state.previews}`,
  contentHash: "c".repeat(64),
  importKind: "skill-md",
  name: "probe",
  description: "Probe the network.",
  size: 400,
  truncated: false,
  files: [{ name: "SKILL.md", size: 400, executable: false }],
  verdict: "ok",
  rules: [],
  blocking: [],
  findings: [],
  newRules: [],
  ...extra,
});

async function setup(page) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const state = {
    agent: { ...agent },
    catalog: [githubSkill],
    previews: 0,
    writes: [],
    patches: [],
  };
  const users = (name) =>
    (state.agent.skills || []).includes(name) ? [{ id: "home", name: "Home" }] : [];
  await page.route(/\/api\/agent-skill-catalog/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method !== "GET")
      state.writes.push({ method, path, body: request.postDataJSON?.() ?? null });
    if (path === "/api/agent-skill-catalog")
      return route.fulfill({
        json: {
          skills: state.catalog.map((skill) => ({ ...skill, agents: users(skill.name) })),
        },
      });
    if (path.endsWith("/skills/preview")) {
      const current = state.catalog.find((skill) => skill.name === "probe");
      return route.fulfill({
        json: current
          ? preview(state, {
              replaces: { id: current.id, version: current.version },
              verdict: "warn",
              rules: ["prompt-injection"],
              findings: [warning],
              newRules: ["prompt-injection"],
            })
          : preview(state),
      });
    }
    if (path === "/api/agent-skill-catalog/skills" && method === "POST") {
      const current = state.catalog.find((skill) => skill.name === "probe");
      const skill = {
        id: "probe-1",
        name: "probe",
        description: "Probe the network.",
        version: current ? current.version + 1 : 1,
        importKind: "skill-md",
        repository: false,
        scan: { verdict: current ? "warn" : "ok", rules: [], overridden: false },
        needsSettings: false,
        state: "ready",
      };
      state.catalog = [...state.catalog.filter((item) => item.name !== "probe"), skill];
      return route.fulfill({ status: 201, json: { skill, replaced: Boolean(current) } });
    }
    if (path.endsWith("/check"))
      return route.fulfill({
        json: state.newer
          ? preview(state, {
              name: "gh-notes",
              importKind: "github",
              replaces: { id: "gh-1", version: 3 },
            })
          : { upToDate: true },
      });
    if (method === "DELETE") {
      const id = path.split("/").pop();
      const removed = state.catalog.find((skill) => skill.id === id);
      state.catalog = state.catalog.filter((skill) => skill.id !== id);
      return route.fulfill({ json: { removed: id, switchedOff: users(removed.name) } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
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
    if (path === "/api/assistants/home/skills") {
      const on = state.agent.skills || [];
      return route.fulfill({
        json: {
          assigned: on,
          shell: "on",
          skills: state.catalog.map((skill) => ({
            name: skill.name,
            source: "catalog",
            version: String(skill.version),
            description: skill.description,
            state: "ready",
            missing: none,
            usesShell: false,
            assigned: on.includes(skill.name),
            active: on.includes(skill.name),
          })),
        },
      });
    }
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
    if (path === "/api/assistant-channels")
      return route.fulfill({ json: { channels: [] } });
    return route.fulfill({ json: {} });
  });
  return state;
}

const catalogRow = (page, name) =>
  page
    .getByRole("group", { name: "Catalog skills" })
    .locator(".list-row", { hasText: name });
const notice = (page) => page.locator("#agents-hub-tabpanel-skills").getByRole("status");
const rowAction = async (page, name, action) => {
  await page.getByRole("button", { name: `Actions for ${name}` }).click();
  await page
    .getByRole("menu", { name: `Actions for ${name}` })
    .getByRole("menuitem", { name: action })
    .click();
};
const skillFile = {
  name: "SKILL.md",
  mimeType: "text/markdown",
  buffer: Buffer.from("---\nname: probe\ndescription: Probe the network.\n---\n"),
};

test("the owner installs, updates, checks and removes catalog skills", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto(`${baseURL}/agents?tab=skills`);
  await expect(page.getByRole("tab", { name: /^Skills/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const github = catalogRow(page, "gh-notes");
  await expect(github).toContainText(
    "Version 3 · from GitHub acme/skills @ main (0123456)",
  );
  await expect(github).toContainText("No findings");
  await expect(github).toContainText("Runs programs: gh, one of jq, yq");
  await expect(github).toContainText("Not switched on for any agent");

  // Install: the form names the catalog, not a host path; nothing is written before
  // the confirmed preview.
  await page.getByRole("button", { name: "Install skill", exact: true }).click();
  let panel = page.getByRole("dialog", { name: "Install skill for all agents" });
  await expect(panel).toContainText("Skill catalog for all agents");
  await panel.getByLabel("Skill file").setInputFiles(skillFile);
  await panel.getByRole("button", { name: "Check skill", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Scan result" })).toBeVisible();
  await panel.getByRole("button", { name: "Add to catalog", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(notice(page)).toContainText("Skill added to the catalog.");
  await expect(catalogRow(page, "probe")).toContainText("Version 1 · from upload");
  await expect(catalogRow(page, "probe")).toContainText(
    "Programs: shown once the agent service runs",
  );
  expect(state.writes.map(({ method, path }) => `${method} ${path}`)).toEqual([
    "POST /api/agent-skill-catalog/skills/preview",
    "POST /api/agent-skill-catalog/skills",
  ]);
  expect(state.writes[1].body).toEqual({
    previewId: "preview-1",
    contentHash: "c".repeat(64),
  });

  // A new version of the same name says what it replaces; a new warning needs the box.
  await rowAction(page, "probe", "Upload new version");
  panel = page.getByRole("dialog", { name: "Upload new version" });
  await panel.getByLabel("Skill file").setInputFiles(skillFile);
  await panel.getByRole("button", { name: "Check skill", exact: true }).click();
  await expect(panel).toContainText("Replaces version 1");
  // The upload names the skill it updates, so the server refuses another one.
  expect(state.writes.at(-1).body).toMatchObject({
    fileName: "SKILL.md",
    skillId: "probe-1",
  });
  await expect(panel).toContainText("New since version 1");
  const update = panel.getByRole("button", { name: "Install update", exact: true });
  await expect(update).toBeDisabled();
  await panel
    .getByRole("checkbox", {
      name: "I have reviewed the warnings and want to install the skill.",
    })
    .check();
  await update.click();
  await expect(panel).toHaveCount(0);
  await expect(catalogRow(page, "probe")).toContainText("Version 2 · from upload");
  await expect(
    page.getByRole("button", { name: "Install skill", exact: true }),
  ).toBeEnabled();
  expect(state.writes.at(-1).body).toEqual({
    previewId: "preview-2",
    contentHash: "c".repeat(64),
    acceptWarnings: true,
  });

  // An unchanged GitHub source is up to date; an upload offers no update check.
  await rowAction(page, "gh-notes", "Check for update");
  await expect(notice(page)).toContainText(
    "Up to date: there is no newer version of gh-notes.",
  );
  expect(state.writes.at(-1).path).toBe("/api/agent-skill-catalog/skills/gh-1/check");
  await page.getByRole("button", { name: "Actions for probe" }).click();
  await expect(
    page.getByRole("menu", { name: "Actions for probe" }).getByRole("menuitem"),
  ).toHaveText(["Upload new version", "Remove"]);
  await page.keyboard.press("Escape");

  // A newer GitHub version opens its preview under its own title.
  state.newer = true;
  await rowAction(page, "gh-notes", "Check for update");
  panel = page.getByRole("dialog", { name: "Update skill" });
  await expect(panel).toContainText("Replaces version 3");
  await expect(page.getByRole("dialog", { name: "Upload new version" })).toHaveCount(0);
  await panel.getByRole("button", { name: "Close dialog" }).click();
  await expect(panel).toHaveCount(0);

  // The agent switches the catalog skill on in its settings.
  await page.goto(baseURL + settingsPath("capabilities", "skills"));
  const toggle = page.locator("#agent-skills-page .toggle-row", { hasText: "probe" });
  await expect(toggle).toContainText("From the skill catalog · version 2");
  await toggle.getByRole("switch").check();
  await saveBar(page).getByRole("button", { name: "Save agent" }).click();
  await expect(saveBar(page)).toHaveCount(0);
  expect(state.patches).toEqual([{ skills: ["probe"], revision: 1 }]);

  // Removing names the agents it is switched off for before anything is deleted.
  await page.goto(`${baseURL}/agents?tab=skills`);
  await expect(catalogRow(page, "probe")).toContainText("On for 1 agent");
  await rowAction(page, "probe", "Remove");
  const confirm = page.getByRole("dialog", { name: "Remove skill “probe”?" });
  await expect(confirm).toContainText("Removing it switches it off for: Home.");
  expect(state.writes.some((write) => write.method === "DELETE")).toBe(false);
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  expect(state.writes.at(-1)).toMatchObject({
    method: "DELETE",
    path: "/api/agent-skill-catalog/skills/probe-1",
  });
  await expect(notice(page)).toContainText("Skill “probe” removed.");
  await expect(catalogRow(page, "probe")).toHaveCount(0);
  await expect(catalogRow(page, "gh-notes")).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    )
    .toBe(true);
});

test("the catalog page names the cause of a skill's limit", async ({ page }) => {
  const state = await setup(page);
  const plain = { ...githubSkill, repository: false, importKind: "skill-md" };
  state.catalog = [
    { ...plain, id: "b", name: "bundled-twin", state: "shadowed", shadowedBy: "bundled" },
    { ...plain, id: "s", name: "plugin-twin", state: "shadowed", shadowedBy: "source" },
    { ...plain, id: "u", name: "not-loaded", state: "unavailable" },
  ];
  await page.goto(`${baseURL}/agents?tab=skills`);
  await expect(catalogRow(page, "bundled-twin")).toContainText(
    "Shadowed by a bundled skill",
  );
  await expect(catalogRow(page, "plugin-twin")).toContainText(
    "Shadowed by another installed skill of the same name",
  );
  await expect(catalogRow(page, "plugin-twin")).not.toContainText("bundled");
  await expect(catalogRow(page, "not-loaded")).toContainText(
    "Not available right now \u2014 AgentPier will check it again",
  );
});

test("the catalog page fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.goto(`${baseURL}/agents?tab=skills`);
  await expect(catalogRow(page, "gh-notes")).toContainText("Runs programs: gh");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
});
