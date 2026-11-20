import { fulfillDormantAssistantRequest } from "../helpers/assistant-browser-fixture.js";
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { runCountsAnswer } from "../helpers/run-counts.js";

// A session archives or writes an entry while the Knowledge tab is open: the
// memory.changed:<projectId> signal makes the tab read its page once.
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
  const reads = { entries: 0 };
  await page.route("**/api/**", async (route) => {
    if (await fulfillDormantAssistantRequest(route)) return;
    const url = new URL(route.request().url());
    let data;
    if (url.pathname === "/api/state")
      data = { tools: [], accounts: [], sessions: [], home: "/workspace" };
    else if (url.pathname === "/api/memory/projects")
      data = { projects: [{ ...project, entryCount: state.items.length }] };
    else if (url.pathname === "/api/repositories")
      data = { credentials: [], projects: [] };
    else if (url.pathname === "/api/agentbus") data = { version: "test", projects: [] };
    else if (url.pathname === "/api/project-groups")
      data = { version: 0, groups: [], assignments: {} };
    else if (url.pathname === "/api/pipeline-runs")
      data = { runs: [], total: 0, page: 1, pageSize: 20 };
    else if (url.pathname === "/api/pipeline-run-counts") data = runCountsAnswer([]);
    else if (url.pathname.endsWith("/entries")) {
      reads.entries += 1;
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
    await liveStub.waitForSubscribe("memory.changed:project-one");
    const before = reads.entries;
    // A session archives the entry and writes a new one.
    state.items = [
      entry({ archived: true, revision: 2 }),
      entry({ id: "e2", title: "Release checklist", content: "Tag, then publish." }),
    ];
    liveStub.changed("memory.changed:project-one");
    await expect(list).toContainText("Release checklist");
    await expect(list).not.toContainText("Deploy");
    expect(reads.entries).toBe(before + 1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
  });
