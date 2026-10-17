import { fulfillDormantAssistantRequest } from "../helpers/assistant-browser-fixture.js";
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

test.use({ locale: "en-GB" });

async function fixture(page) {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
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
    title: "Deploy token",
    content: "token fixture-secret",
    revision: 2,
    archived: false,
    createdAt: "2026-09-07T00:00:00Z",
    updatedAt: "2026-09-07T00:00:00Z",
    provenance: { kind: "user" },
  };
  const deletes = [];
  await page.route("**/api/**", async (route) => {
    if (await fulfillDormantAssistantRequest(route)) return;
    const request = route.request(),
      url = new URL(request.url()),
      method = request.method();
    let data;
    if (url.pathname === "/api/state")
      data = { tools: [], accounts: [], sessions: [], home: "/workspace" };
    else if (url.pathname === "/api/repositories")
      data = { credentials: [], projects: [] };
    else if (url.pathname === "/api/agentbus") data = { version: "test", projects: [] };
    else if (url.pathname === "/api/pipeline-runs")
      data = { runs: [], total: 0, page: 1, pageSize: 20 };
    else if (url.pathname === "/api/memory/projects") data = { projects: [project] };
    else if (url.pathname.endsWith("/entries/note-one") && method === "DELETE") {
      deletes.push(request.postDataJSON());
      data = { id: entry.id, projectId: project.id, revisions: 2, removedBackups: 1 };
    } else if (url.pathname.endsWith("/entries")) {
      const visible = !deletes.length && url.searchParams.get("archived") !== "true";
      data = {
        projectId: project.id,
        items: visible ? [entry] : [],
        page: 1,
        pageSize: 20,
        total: visible ? 1 : 0,
      };
    } else throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    await route.fulfill({ status: 200, json: data });
  });
  return { deletes };
}

test("the owner forgets a knowledge entry after a warning about backup archives", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(baseURL + "/projects/project-one?tab=knowledge");
  await page.getByRole("button", { name: "Deploy token", exact: true }).click();
  await page.getByRole("button", { name: "Forget permanently: Deploy token" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Forget entry permanently" }),
  ).toBeVisible();
  await expect(dialog).toContainText("Existing backup archives");
  await expect(dialog).toContainText("Only identical text is blocked");
  const backups = dialog.getByRole("checkbox", { name: /migration backups/ });
  await expect(backups).not.toBeChecked();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.deletes).toEqual([]);

  await page.getByRole("button", { name: "Forget permanently: Deploy token" }).click();
  await dialog.getByRole("textbox", { name: /Reason/ }).fill("Leaked");
  await backups.check();
  await dialog.getByRole("button", { name: "Forget permanently", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText("No entries yet.")).toBeVisible();
  expect(state.deletes).toEqual([
    { expectedRevision: 2, reason: "Leaked", removeBackups: true },
  ]);
});
