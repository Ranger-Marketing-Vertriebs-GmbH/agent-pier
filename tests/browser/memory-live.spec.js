import { fulfillDormantAssistantRequest } from "../helpers/assistant-browser-fixture.js";
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { runCountsAnswer } from "../helpers/run-counts.js";

// A session archives or writes an entry while the Knowledge tab is open: the
// memory.changed:<projectId> signal makes the tab read its page once, and its Active
// and Archive totals and the Knowledge tab count follow.
test.use({ locale: "en-GB" });

const project = { id: "project-one", name: "AgentPier", cwd: "/workspace/agentpier" };
const entry = (fields) => ({
  id: "e1",
  projectId: project.id,
  title: "Deploy",
  content: "Use the staging host.",
  revision: 1,
  archived: false,
  createdAt: "2026-11-20T21:00:00Z",
  updatedAt: "2026-11-20T21:00:00Z",
  provenance: { kind: "user" },
  ...fields,
});

async function fixture(page, state) {
  const reads = { entries: 0, counts: 0 };
  await page.route("**/api/**", async (route) => {
    if (await fulfillDormantAssistantRequest(route)) return;
    const url = new URL(route.request().url());
    let data;
    if (url.pathname === "/api/state")
      data = { tools: [], accounts: [], sessions: [], home: "/workspace" };
    else if (url.pathname === "/api/memory/projects")
      data = {
        projects: [
          { ...project, entryCount: state.items.filter((item) => !item.archived).length },
        ],
      };
    else if (url.pathname === "/api/repositories")
      data = { credentials: [], projects: [] };
    else if (url.pathname === "/api/agentbus") data = { version: "test", projects: [] };
    else if (url.pathname === "/api/project-groups")
      data = { version: 0, groups: [], assignments: {} };
    else if (url.pathname === "/api/pipeline-runs")
      data = { runs: [], total: 0, page: 1, pageSize: 20 };
    else if (url.pathname === "/api/pipeline-run-counts") data = runCountsAnswer([]);
    else if (url.pathname.endsWith("/entries")) {
      // The list sends its search term; the totals read page 1 without one.
      if (url.searchParams.has("q")) reads.entries += 1;
      else reads.counts += 1;
      const archived = url.searchParams.get("archived") === "true";
      const items = state.items.filter((item) => item.archived === archived);
      data = { projectId: project.id, items, page: 1, pageSize: 20, total: items.length };
    } else throw new Error(`Unexpected request: ${url.pathname}`);
    await route.fulfill({ json: data });
  });
  return reads;
}

for (const [width, height] of [
  [1280, 800],
  [390, 844],
])
  test(`the Knowledge tab follows writes made elsewhere at ${width}px`, async ({
    page,
    liveStub,
  }) => {
    await page.setViewportSize({ width, height });
    const state = { items: [entry()] };
    const reads = await fixture(page, state);
    await page.goto(baseURL + "/projects/project-one?tab=knowledge");
    const list = page.locator(".project-knowledge-entries");
    await expect(list).toContainText("Deploy");
    const status = page.getByRole("radiogroup", { name: "Knowledge entries" });
    const knowledgeTab = page.getByRole("tab", { name: /Knowledge/ });
    await expect(status).toContainText("Active · 1");
    await expect(status).toContainText("Archive · 0");
    await expect(knowledgeTab.locator("small")).toHaveText("1");
    await liveStub.waitForSubscribe("memory.changed:project-one");
    const before = reads.entries;
    // A session archives the entry and writes a new one.
    state.items = [
      entry({ archived: true, revision: 2 }),
      entry({ id: "e2", title: "Release checklist", content: "Tag, then publish." }),
      entry({ id: "e3", title: "Ports", content: "The stage uses 4380." }),
    ];
    liveStub.changed("memory.changed:project-one");
    await expect(list).toContainText("Release checklist");
    await expect(list).not.toContainText("Deploy");
    await expect(status).toContainText("Active · 2");
    await expect(status).toContainText("Archive · 1");
    await expect(knowledgeTab.locator("small")).toHaveText("2");
    expect(reads.entries).toBe(before + 1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
  });
