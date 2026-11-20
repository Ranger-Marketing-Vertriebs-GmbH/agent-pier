import { fulfillDormantAssistantRequest } from "../helpers/assistant-browser-fixture.js";
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { runCountsAnswer } from "../helpers/run-counts.js";

test.use({ locale: "en-GB" });

const project = { id: "project-one", name: "AgentPier", cwd: "/workspace/agentpier" };
const note = (id, title, updatedAt) => ({
  id,
  projectId: project.id,
  title,
  content: `${title} content`,
  revision: 1,
  archived: false,
  createdAt: updatedAt,
  updatedAt,
  provenance: { kind: "user" },
});
// The relevant entry is the older one, so the two orders differ.
const relevant = note("e1", "Build command", "2026-09-01T00:00:00Z"),
  recent = note("e2", "Release notes", "2026-09-07T00:00:00Z");

async function fixture(page) {
  const searches = [];
  await page.route("**/api/**", async (route) => {
    if (await fulfillDormantAssistantRequest(route)) return;
    const url = new URL(route.request().url());
    let data;
    if (url.pathname === "/api/state")
      data = { tools: [], accounts: [], sessions: [], home: "/workspace" };
    else if (url.pathname === "/api/memory/projects")
      data = { projects: [{ ...project, entryCount: 2 }] };
    else if (url.pathname === "/api/repositories")
      data = { credentials: [], projects: [] };
    else if (url.pathname === "/api/agentbus") data = { version: "test", projects: [] };
    else if (url.pathname === "/api/project-groups")
      data = { version: 0, groups: [], assignments: {} };
    else if (url.pathname === "/api/pipeline-runs")
      data = { runs: [], total: 0, page: 1, pageSize: 20 };
    else if (url.pathname === "/api/pipeline-run-counts") data = runCountsAnswer([]);
    else if (url.pathname.endsWith("/revisions"))
      data = {
        items: [{ ...recent, updatedAt: "2026-11-20T21:42:02.004Z" }],
        page: 1,
        pageSize: 20,
        total: 1,
      };
    else if (url.pathname.endsWith("/entries")) {
      const query = url.searchParams.get("q") || "";
      const sort = url.searchParams.get("sort");
      if (query) searches.push(sort);
      const items =
        url.searchParams.get("archived") === "true"
          ? []
          : query === "nothing"
            ? []
            : query && sort === "relevance"
              ? [relevant, recent]
              : [recent, relevant];
      data = { projectId: project.id, items, page: 1, pageSize: 20, total: items.length };
    } else throw new Error(`Unexpected request: ${url.pathname}`);
    await route.fulfill({ json: data });
  });
  return searches;
}

const titles = (page) => page.locator(".project-knowledge-entries [aria-expanded]");

test("searching sorts by relevance by default and can switch to newest first", async ({
  page,
}) => {
  const searches = await fixture(page);
  await page.goto(baseURL + "/projects/project-one?tab=knowledge");
  await expect(titles(page)).toContainText(["Release notes", "Build command"]);
  // Without a search term there is no order to choose: the newest entries come first.
  await expect(page.getByRole("radio", { name: "Most relevant" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Search knowledge" }).fill("build");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Most relevant" })).toBeChecked();
  await expect(titles(page)).toContainText(["Build command", "Release notes"]);
  await page.getByRole("radio", { name: "Newest first" }).check();
  await expect(page).toHaveURL(/[?&]sort=newest/);
  await expect(titles(page)).toContainText(["Release notes", "Build command"]);
  await page.reload();
  await expect(page.getByRole("radio", { name: "Newest first" })).toBeChecked();
  // Clearing the term drops the order with it.
  await page.getByRole("textbox", { name: "Search knowledge" }).fill("");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/projects/project-one?tab=knowledge`);
  await expect(page.getByRole("radio", { name: "Newest first" })).toHaveCount(0);
  expect(searches).toContain("relevance");
  expect(searches.at(-1)).toBe("newest");
});

for (const [width, height] of [
  [1280, 800],
  [390, 844],
])
  test(`typing searches, an empty search says so, history shows local times at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await fixture(page);
    await page.goto(baseURL + "/projects/project-one?tab=knowledge");
    await expect(titles(page)).toContainText(["Release notes", "Build command"]);
    // No Enter: the search runs after a short pause.
    await page.getByRole("textbox", { name: "Search knowledge" }).fill("nothing");
    await expect(page).toHaveURL(/[?&]q=nothing/);
    await expect(page.getByText("No entries match this search.")).toBeVisible();
    await expect(page.getByText("No entries yet.")).toHaveCount(0);
    await page.getByRole("textbox", { name: "Search knowledge" }).fill("");
    await expect(titles(page)).toContainText(["Release notes", "Build command"]);
    await titles(page).first().click();
    await page.getByRole("button", { name: "Versions: Release notes" }).click();
    const dialog = page.getByRole("dialog", { name: "Version history" });
    await expect(dialog.locator("time")).toHaveAttribute(
      "datetime",
      "2026-11-20T21:42:02.004Z",
    );
    await expect(dialog).not.toContainText("2026-11-20T21:42");
    await expect(dialog.locator("time")).toContainText("2026");
  });
