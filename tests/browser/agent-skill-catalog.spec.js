import { test, expect } from "../helpers/browser-test.js";
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
// A row opens the skill's detail view, which holds its facts and its actions.
const openDetail = async (page, name) => {
  const detail = page.getByRole("dialog", { name, exact: true });
  if (!(await detail.isVisible()))
    await catalogRow(page, name).getByRole("button").click();
  await expect(detail).toBeVisible();
  return detail;
};
const closeDetail = async (detail) => {
  await detail.getByRole("button", { name: "Close", exact: true }).click();
  await expect(detail).toHaveCount(0);
};
const fact = (detail, term) =>
  detail.locator(".skill-facts div", { hasText: term }).locator("dd");
const detailAction = async (page, name, action) => {
  const detail = await openDetail(page, name);
  await detail.getByRole("button", { name: action, exact: true }).click();
  return detail;
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
  // The row is short: description and use. The source stands once above its group.
  await expect(github).toContainText("Notes from GitHub issues.");
  await expect(github).toContainText("Unused");
  await expect(github).not.toContainText("acme/skills");
  const list = page.getByRole("group", { name: "Catalog skills" });
  await expect(list.getByRole("heading", { name: "acme/skills" })).toBeVisible();
  await expect(list).toContainText("main · 0123456 · 1 skill");
  let detail = await openDetail(page, "gh-notes");
  await expect(detail).toContainText("No findings");
  await expect(detail).toContainText("Not switched on for any agent");
  await expect(fact(detail, "Source")).toHaveText("acme/skills");
  await expect(fact(detail, "Revision")).toHaveText("main · 0123456");
  await expect(fact(detail, "Version")).toHaveText("3");
  await expect(fact(detail, "Programs")).toHaveText("gh, one of jq, yq");
  await closeDetail(detail);

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
  await expect(list.getByRole("heading", { name: "Uploaded" })).toBeVisible();
  detail = await openDetail(page, "probe");
  await expect(fact(detail, "Source")).toHaveText("Upload");
  await expect(fact(detail, "Version")).toHaveText("1");
  await expect(fact(detail, "Programs")).toHaveText("Shown once the agent service runs");
  expect(state.writes.map(({ method, path }) => `${method} ${path}`)).toEqual([
    "POST /api/agent-skill-catalog/skills/preview",
    "POST /api/agent-skill-catalog/skills",
  ]);
  expect(state.writes[1].body).toEqual({
    previewId: "preview-1",
    contentHash: "c".repeat(64),
  });

  // A new version of the same name says what it replaces; a new warning needs the box.
  await detailAction(page, "probe", "Upload new version");
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
  // The detail view returns with the new version and marks the warning in the row.
  detail = page.getByRole("dialog", { name: "probe", exact: true });
  await expect(fact(detail, "Version")).toHaveText("2");
  await expect(detail).toContainText("Skill updated.");
  // An upload offers no update check.
  await expect(detail.getByRole("button", { name: "Check for update" })).toHaveCount(0);
  await closeDetail(detail);
  await expect(catalogRow(page, "probe")).toContainText("Warnings");
  await expect(
    page.getByRole("button", { name: "Install skill", exact: true }),
  ).toBeEnabled();
  expect(state.writes.at(-1).body).toEqual({
    previewId: "preview-2",
    contentHash: "c".repeat(64),
    acceptWarnings: true,
  });

  // An unchanged GitHub source is up to date; the detail view says so.
  detail = await detailAction(page, "gh-notes", "Check for update");
  await expect(detail.getByRole("status")).toContainText(
    "Up to date: there is no newer version of gh-notes.",
  );
  expect(state.writes.at(-1).path).toBe("/api/agent-skill-catalog/skills/gh-1/check");

  // A newer GitHub version opens its preview under its own title.
  state.newer = true;
  await detailAction(page, "gh-notes", "Check for update");
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
  await expect(catalogRow(page, "probe")).toContainText("1 agent");
  await detailAction(page, "probe", "Remove skill probe");
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
  await expect(catalogRow(page, "gh-notes")).toContainText("Notes from GitHub issues.");
  const fits = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await fits()).toBe(true);
  // The detail view and its switches stay inside the screen.
  const detail = await openDetail(page, "gh-notes");
  const toggle = detail.getByRole("switch", { name: "Home" });
  await expect(toggle).toBeVisible();
  const box = await toggle.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await fits()).toBe(true);
});

test("the owner searches, filters and switches a skill on for an agent", async ({
  page,
}) => {
  const state = await setup(page);
  const long = "Use when the user asks to plan a trip. ".repeat(20).trim();
  state.catalog = [
    githubSkill,
    { ...githubSkill, id: "gh-2", name: "gh-trips", description: long },
    {
      ...githubSkill,
      id: "up-1",
      name: "blocked-twin",
      importKind: "skill-md",
      origin: undefined,
      repository: false,
      state: "unavailable",
    },
  ];
  await page.goto(`${baseURL}/agents?tab=skills`);
  const list = page.getByRole("group", { name: "Catalog skills" });
  await expect(list.locator(".list-row")).toHaveCount(3);
  await expect(list).toContainText("main · 0123456 · 2 skills");
  // A long description takes two lines in the list.
  const clamped = catalogRow(page, "gh-trips").locator(".skill-row-description");
  const height = await clamped.evaluate((node) => node.getBoundingClientRect().height);
  expect(height).toBeLessThan(45);

  const chips = page.getByRole("group", { name: "Filter skills" });
  await expect(chips.getByRole("button")).toHaveText([
    /All\s*3/,
    /In use\s*0/,
    /Unused\s*3/,
    /With findings\s*1/,
  ]);
  await chips.getByRole("button", { name: /With findings/ }).click();
  await expect(list.locator(".list-row")).toHaveText([/blocked-twin/]);
  await chips.getByRole("button", { name: /^All/ }).click();
  await page.getByRole("searchbox", { name: "Search skills" }).fill("trip");
  await expect(list.locator(".list-row")).toHaveText([/gh-trips/]);
  await expect(chips.getByRole("button", { name: /^All/ })).toContainText("1");
  await page.getByRole("searchbox", { name: "Search skills" }).fill("nothing here");
  await expect(page.getByText("No skills match your search or filter.")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search skills" }).fill("");

  // The switch saves at once through the agent's own update.
  let detail = await openDetail(page, "gh-trips");
  await expect(detail).toContainText(long);
  // The switch shows the saved state, so it turns once the agent is saved.
  await detail.getByRole("switch", { name: "Home" }).click();
  await expect(detail.getByRole("switch", { name: "Home" })).toBeChecked();
  await expect.poll(() => state.patches).toEqual([{ skills: ["gh-trips"], revision: 1 }]);
  await expect(detail).toContainText("On for 1 agent");
  await detail.getByRole("switch", { name: "Home" }).click();
  await expect(detail.getByRole("switch", { name: "Home" })).not.toBeChecked();
  await expect.poll(() => state.patches.at(-1)).toEqual({ skills: [], revision: 2 });
  await expect(detail).toContainText("Not switched on for any agent");
  await closeDetail(detail);
  await expect(catalogRow(page, "gh-trips")).toContainText("Unused");

  // A skill that cannot be used right now is not offered.
  detail = await openDetail(page, "blocked-twin");
  await expect(detail.getByRole("switch", { name: "Home" })).toBeDisabled();
  await expect(fact(detail, "State")).toHaveText(
    "Not available right now \u2014 AgentPier will check it again",
  );
});
