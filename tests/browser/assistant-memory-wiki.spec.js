import fs from "node:fs";
import path from "node:path";
import { test, expect } from "../helpers/browser-test.js";
import { fixture } from "./providers-fixture.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";

// The memory wiki of an OpenClaw agent (ADR 0007, step 7b): OpenClaw's switch in the
// slot agent.capabilities, locked with the reason for an agent that may not keep a
// wiki, and the read page in the slot agent.page with the list of pages (the live
// topic agent.wiki, read from its route here) and one page rendered read only.
const copy = {
  en: {
    group: "Memory wiki",
    switch: "Keep a memory wiki",
    restarts: "Switching on the first wiki restarts the agent service.",
    locked:
      "Only your own agents can keep a memory wiki, not an agent shared with users.",
    open: "Read the wiki",
    pages: "Pages",
    synthesis: "Synthesis",
    back: "All pages",
    count: "2 of 13 pages listed",
    save: "Save",
    unsaved: "Unsaved changes",
    memory: "Memory",
    wikiLink: "Wiki",
  },
  de: {
    group: "Memory-Wiki",
    switch: "Memory-Wiki führen",
    restarts: "Das erste eingeschaltete Wiki startet den Agentendienst neu.",
    locked:
      "Nur deine eigenen Agenten können ein Memory-Wiki führen, kein mit Nutzern geteilter Agent.",
    open: "Wiki lesen",
    pages: "Seiten",
    synthesis: "Synthese",
    back: "Alle Seiten",
    count: "2 von 13 Seiten aufgeführt",
    save: "Speichern",
    unsaved: "Ungespeicherte Änderungen",
    memory: "Gedächtnis",
    wikiLink: "Wiki",
  },
};
const openClawInfo = {
  id: "openclaw",
  name: "OpenClaw",
  version: "2026.11.3",
  capabilities: {},
};
const surfaces = [
  { id: "memoryWiki", slot: "agent.capabilities", kind: "built", shows: "whileEnabled" },
  { id: "wiki", slot: "agent.page", kind: "built", shows: "whileEnabled" },
];
const runtimes = {
  runtimes: [{ ...openClawInfo, surfaces, install: { kind: "builtin" }, ready: true }],
};
const owl = {
  id: "home",
  name: "Owl",
  instructions: "",
  revision: 1,
  effectiveRevision: 1,
  runtime: "openclaw",
  runtimeInfo: openClawInfo,
  model: { connectionId: "router", modelId: "a/b" },
  capabilities: { memory: true, reminders: false },
};
const keeper = {
  runtimeOptions: { openclaw: { memoryWiki: true } },
  runtimePages: ["wiki"],
};
const models = [
  { id: "router", name: "Router", providerId: "openrouter", available: true },
];
const listing = {
  state: "ready",
  totalPages: 13,
  truncated: false,
  pages: [
    {
      lookup: "syntheses/quartz-notes.md",
      title: "Quartz Notes",
      kind: "synthesis",
      updatedAt: "2026-11-17T08:06:02.293Z",
    },
    {
      lookup: "entities/owner.md",
      title: "Owner",
      kind: "entity",
      updatedAt: "2026-11-16T09:00:00.000Z",
    },
  ],
};
const quartz = {
  lookup: "syntheses/quartz-notes.md",
  title: "Quartz Notes",
  kind: "synthesis",
  updatedAt: "2026-11-17T08:06:02.293Z",
  content:
    "\n# Quartz Notes\n\n## Summary\n\nQuartz is grey and the owner likes it.\n\n- Source: [MEMORY](../sources/memory.md)\n",
  truncated: false,
};
const shots = process.env.AGENTPIER_SCREENSHOT_DIR;
async function shoot(locator, name, testInfo) {
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const file = shots ? path.join(shots, name) : testInfo.outputPath(name);
  await locator.screenshot({ path: file });
  await testInfo.attach(name, { path: file, contentType: "image/png" });
}

// A stand-in for the server that keeps what a PATCH stores on the profile.
async function setup(page, language, agent = {}) {
  await fixture(page);
  await page.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  const state = { agent: { ...owl, ...agent }, patches: [], reads: [] };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    if (pathname === "/api/assistant-runtimes") return route.fulfill({ json: runtimes });
    if (pathname === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    if (request.method() === "PATCH") {
      const body = request.postDataJSON();
      state.patches.push(body);
      const on = body.runtimeOptions?.openclaw?.memoryWiki === true;
      state.agent = {
        ...state.agent,
        ...body,
        revision: state.agent.revision + 1,
        ...(on ? { runtimePages: ["wiki"] } : { runtimePages: undefined }),
      };
      return route.fulfill({ json: { ...state.agent, pending: false } });
    }
    if (pathname === "/api/assistants")
      return route.fulfill({
        json: { assistants: [state.agent], conversations: [], models },
      });
    if (pathname === "/api/assistant-runtime")
      return route.fulfill({
        json: { availability: "ready", sync: "current", browser: { available: true } },
      });
    if (pathname === "/api/assistants/home/wiki") return route.fulfill({ json: listing });
    if (pathname === "/api/assistants/home/wiki/page") {
      state.reads.push(url.searchParams.get("lookup"));
      return route.fulfill({ json: quartz });
    }
    if (pathname === "/api/assistants/home/memory/files")
      return route.fulfill({ json: { files: [], nextOffset: null } });
    if (pathname === "/api/assistants/home/memory")
      return route.fulfill({
        json: { name: "MEMORY.md", content: "Owner likes quartz", hash: "h1" },
      });
    if (pathname === "/api/assistants/home/memory/archive")
      return route.fulfill({ json: { entries: [] } });
    return route.fulfill({ json: {} });
  });
  return state;
}
const group = (page, name) => page.getByRole("region", { name, exact: true });

for (const [language, text] of Object.entries(copy))
  test.describe(language, () => {
    test("the owner switches the wiki on with the tab and opens it", async ({
      page,
    }, testInfo) => {
      const state = await setup(page, language);
      await page.goto(settingsPath("capabilities"));
      const wiki = group(page, text.group);
      await expect(wiki).toBeVisible();
      await expect(wiki).toContainText(text.restarts);
      await expect(wiki.getByRole("link", { name: text.open })).toHaveCount(0);
      await wiki.getByRole("switch", { name: text.switch }).check();
      await saveBar(page, text.unsaved).getByRole("button", { name: text.save }).click();
      await expect.poll(() => state.patches.length).toBe(1);
      expect(state.patches[0]).toEqual({
        runtimeOptions: { openclaw: { memoryWiki: true } },
        revision: 1,
      });
      // Saved: the link to the read page shows beside the switch.
      const link = wiki.getByRole("link", { name: text.open });
      await expect(link).toBeVisible();
      await shoot(wiki, `runtime-wiki-switch-${language}.png`, testInfo);
      await link.click();
      await expect(page).toHaveURL(/page=wiki/);
      await expect(page.getByRole("heading", { name: text.group })).toBeVisible();
    });

    test("an agent shared with users shows the switch locked with the reason", async ({
      page,
    }) => {
      await setup(page, language, {
        userAccess: {
          mode: "shared",
          members: [{ userId: "u1", level: "chat" }],
          released: [],
        },
      });
      await page.goto(settingsPath("capabilities"));
      const wiki = group(page, text.group);
      await expect(wiki).toContainText(text.locked);
      const toggle = wiki.getByRole("switch", { name: text.switch });
      await expect(toggle).toBeDisabled();
      await expect(toggle).not.toBeChecked();
    });

    test("the read page lists the pages and shows one read only", async ({
      page,
    }, testInfo) => {
      const state = await setup(page, language, keeper);
      await page.goto(settingsPath("capabilities", "wiki"));
      const pages = page.getByRole("group", { name: text.pages });
      await expect(pages.getByRole("button", { name: /Quartz Notes/ })).toBeVisible();
      await expect(pages).toContainText(text.synthesis);
      await expect(pages).toContainText(text.count);
      await shoot(
        page.locator("[data-surface=wiki]"),
        `runtime-wiki-page-list-${language}.png`,
        testInfo,
      );
      await pages.getByRole("button", { name: /Quartz Notes/ }).click();
      const article = page.getByRole("article", { name: "Quartz Notes" });
      await expect(article.getByRole("heading", { name: "Quartz Notes" })).toBeVisible();
      await expect(article).toContainText("Quartz is grey and the owner likes it.");
      expect(state.reads).toEqual(["syntheses/quartz-notes.md"]);
      // Read only: nothing to type into, nothing to save.
      await expect(article.getByRole("textbox")).toHaveCount(0);
      await expect(saveBar(page, text.unsaved)).toHaveCount(0);
      await shoot(
        page.locator("[data-surface=wiki]"),
        `runtime-wiki-page-${language}.png`,
        testInfo,
      );
      await page.getByRole("button", { name: text.back }).click();
      await expect(pages).toBeVisible();
    });

    test("the memory page links to the wiki; without one there is no page", async ({
      page,
    }) => {
      await setup(page, language, keeper);
      await page.goto(settingsPath("capabilities", "memory"));
      await page.getByRole("link", { name: text.wikiLink, exact: true }).click();
      await expect(page).toHaveURL(/page=wiki/);
      await expect(page.getByRole("group", { name: text.pages })).toBeVisible();
    });

    test("an agent without a wiki has no wiki page", async ({ page }) => {
      await setup(page, language);
      await page.goto(settingsPath("capabilities", "wiki"));
      await expect(page).not.toHaveURL(/page=wiki/);
      await expect(page.locator("[data-surface=wiki]")).toHaveCount(0);
    });
  });
