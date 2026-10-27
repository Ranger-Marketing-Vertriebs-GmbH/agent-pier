import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
import { hubFixture } from "./projects-fixture.js";

const phone = { width: 390, height: 844 };
const noOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

// The agents' Work tab access, answered like the server (project-agent-access.js):
// a stale `expected` is a conflict, removing the grant removes the folder level.
function agentAccess({ conflictOnce = false } = {}) {
  const state = {
    home: { coding: false, folder: "none" },
    puts: [],
    conflict: conflictOnce,
  };
  const intercept = async (route, url, method) => {
    if (url.pathname === "/api/assistants") {
      await route.fulfill({
        json: {
          assistants: [
            { id: "home", name: "Home" },
            { id: "gone", name: "Gone", archivedAt: "2026-10-01T00:00:00Z" },
            { id: "task", name: "Task", teamMemberId: "t1", lifetime: "task" },
          ],
          conversations: [],
        },
      });
      return true;
    }
    const match = /^\/api\/assistant-project-access\/([^/]+)(?:\/([^/]+))?$/.exec(
      url.pathname,
    );
    if (!match) return false;
    if (method === "PUT") {
      const body = route.request().postDataJSON();
      state.puts.push({ projectId: match[1], agentId: match[2], ...body });
      if (state.conflict) {
        state.conflict = false;
        state.home = { coding: true, folder: "read" };
        await route.fulfill({
          status: 409,
          json: { error: "Changed", messageKey: "assistants.conflict" },
        });
        return true;
      }
      state.home = body.coding
        ? { coding: true, folder: body.folder }
        : { coding: false, folder: "none" };
      await route.fulfill({ json: { id: match[2], revision: 2, ...state.home } });
      return true;
    }
    await route.fulfill({
      json: {
        agents: [{ id: "home", name: "Home", revision: 1, ...state.home }],
        // A task-bound member's folder from its lead (task-member-grants.js).
        memberGrants: [
          {
            id: "task:writer:project:m1",
            kind: "project",
            revocable: true,
            agentId: "writer",
            name: "Writer",
            leadId: "home",
            leadName: "Home",
            folder: "read",
            coding: false,
          },
        ],
      },
    });
    return true;
  };
  return { state, intercept };
}

test.describe("English project agents", () => {
  test.use({ locale: "en-GB" });

  for (const [label, viewport] of [
    ["desktop", null],
    ["phone", phone],
  ])
    test(`the Agents tab sets folder access and coding through the Work tab access on ${label}`, async ({
      page,
    }) => {
      if (viewport) await page.setViewportSize(viewport);
      const access = agentAccess();
      await hubFixture(page, { intercept: access.intercept });
      await page.goto(base + "/projects/m1?tab=agents");
      const agent = page.locator('[data-project-agent="home"]');
      await expect(agent.getByRole("heading", { name: "Home" })).toBeVisible();
      const coding = agent.getByLabel("May start coding sessions in this project");
      await expect(coding).not.toBeChecked();
      await expect(agent.getByLabel("None", { exact: true })).toBeChecked();
      // Choosing a folder level grants the project as well.
      await agent.getByLabel("Read and write", { exact: true }).check();
      await expect(coding).toBeChecked();
      expect(access.state.puts.at(-1)).toEqual({
        projectId: "m1",
        agentId: "home",
        expected: { coding: false, folder: "none" },
        coding: true,
        folder: "write",
        sessions: false,
      });
      // Removing the grant removes the folder level too.
      await coding.uncheck();
      await expect(agent.getByLabel("None", { exact: true })).toBeChecked();
      expect(access.state.puts.at(-1)).toMatchObject({ coding: false, folder: "none" });
      await expect(
        page.getByText("via Home · Task-bound member · Folder: read", { exact: true }),
      ).toBeVisible();
      expect(await noOverflow(page)).toBe(true);
    });

  test("a change made elsewhere reloads the agent and says so", async ({ page }) => {
    const access = agentAccess({ conflictOnce: true });
    await hubFixture(page, { intercept: access.intercept });
    await page.goto(base + "/projects/m1?tab=agents");
    const agent = page.locator('[data-project-agent="home"]');
    await agent.getByLabel("Read", { exact: true }).check();
    await expect(page.getByText(/changed elsewhere in the meantime/)).toBeVisible();
    await expect(agent.getByLabel("Read", { exact: true })).toBeChecked();
    await expect(
      agent.getByLabel("May start coding sessions in this project"),
    ).toBeChecked();
  });

  test("adding a folder can give permanent agents access right away", async ({
    page,
  }) => {
    await page.setViewportSize(phone);
    const access = agentAccess();
    await hubFixture(page, { intercept: access.intercept });
    await page.goto(base + "/projects");
    await page.getByRole("button", { name: "Add project" }).first().click();
    await page.getByRole("menuitem", { name: "Add folder" }).click();
    const dialog = page.getByRole("dialog", { name: "Add project" });
    // Archived agents and task members are not offered.
    await expect(dialog.getByLabel("Gone")).toHaveCount(0);
    await expect(dialog.getByLabel("Task")).toHaveCount(0);
    await dialog.getByLabel("Home").selectOption({ label: "Coding and read folder" });
    await dialog.getByLabel("Project directory", { exact: true }).fill("/work/new");
    await dialog.getByRole("button", { name: "Add project" }).click();
    await expect(dialog).toHaveCount(0);
    expect(access.state.puts).toEqual([
      {
        projectId: "m3",
        agentId: "home",
        expected: { coding: false, folder: "none" },
        coding: true,
        folder: "read",
      },
    ]);
  });

  test("an agent of users gets folders only, here and when adding a folder", async ({
    page,
  }) => {
    const puts = [];
    const lotta = { coding: false, folder: "none" };
    const intercept = async (route, url, method) => {
      if (url.pathname === "/api/assistants") {
        await route.fulfill({
          json: {
            assistants: [
              {
                id: "lotta",
                name: "Lotta",
                userAccess: { mode: "own", members: [{ userId: "u-1", level: "chat" }] },
              },
            ],
            conversations: [],
          },
        });
        return true;
      }
      const match = /^\/api\/assistant-project-access\/([^/]+)(?:\/([^/]+))?$/.exec(
        url.pathname,
      );
      if (!match) return false;
      if (method === "PUT") {
        const body = route.request().postDataJSON();
        puts.push({ projectId: match[1], ...body });
        Object.assign(lotta, { coding: body.coding, folder: body.folder });
        await route.fulfill({ json: { id: match[2], revision: 2, ...lotta } });
        return true;
      }
      await route.fulfill({
        json: {
          agents: [
            { id: "lotta", name: "Lotta", revision: 1, foldersOnly: true, ...lotta },
          ],
        },
      });
      return true;
    };
    await page.setViewportSize(phone);
    await hubFixture(page, { intercept });
    await page.goto(base + "/projects/m1?tab=agents");
    const agent = page.locator('[data-project-agent="lotta"]');
    await expect(agent.getByText(/Locked for agents of users/)).toBeVisible();
    await expect(
      agent.getByLabel("May start coding sessions in this project"),
    ).toHaveCount(0);
    await agent.getByLabel("Read", { exact: true }).check();
    await expect.poll(() => puts.length).toBe(1);
    expect(puts[0]).toMatchObject({ coding: false, folder: "read" });

    await page.goto(base + "/projects");
    await page.getByRole("button", { name: "Add project" }).first().click();
    await page.getByRole("menuitem", { name: "Add folder" }).click();
    const dialog = page.getByRole("dialog", { name: "Add project" });
    const pick = dialog.getByLabel("Lotta");
    await expect(pick.locator("option")).toHaveText([
      "No access",
      "Read folder",
      "Read and write folder",
    ]);
    await pick.selectOption({ label: "Read and write folder" });
    await dialog.getByLabel("Project directory", { exact: true }).fill("/work/new");
    await dialog.getByRole("button", { name: "Add project" }).click();
    await expect(dialog).toHaveCount(0);
    expect(puts.at(-1)).toEqual({
      projectId: "m3",
      expected: { coding: false, folder: "none" },
      coding: false,
      folder: "write",
    });
  });
});
