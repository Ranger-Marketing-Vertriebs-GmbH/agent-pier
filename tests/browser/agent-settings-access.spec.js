import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { setupAssistantSettings as setup } from "../helpers/assistant-settings-browser.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";
import { nas, opnsense } from "./assistant-ssh-fixture.js";

// AC-AS-3: the Access tab's inline add fields, operated with the keyboard only.
const projects = [
  { id: "p1", name: "Notes", path: "/work/notes" },
  { id: "p2", name: "Website", path: "/work/website" },
  { id: "p3", name: "Wiki", path: "/work/wiki" },
];
const servers = [
  { id: "m1", name: "Calendar", transport: "http" },
  { id: "m2", name: "Tickets", transport: "http" },
];
const save = (page) =>
  saveBar(page).getByRole("button", { name: "Save agent", exact: true });

async function openAccess(page, options = {}) {
  const state = await setup(page, {
    assistant: { mcpServers: [] },
    applyUpdates: true,
    mcpServers: servers,
    catalog: { projects, pipelines: [], sshHosts: [opnsense, nas], secrets: [] },
    access: { revision: 0, projectIds: ["p1"], projectFiles: {} },
    ...options,
  });
  await page.goto(baseURL + settingsPath("access"));
  return state;
}

test("projects, SSH hosts and MCP servers are added with the keyboard and saved", async ({
  page,
}) => {
  const state = await openAccess(page);

  // Projects: filter, granted entries disabled, multi-select, folder level as mode.
  const project = page.getByRole("combobox", { name: "Add project" });
  await project.focus();
  await page.keyboard.type("w");
  await expect(page.getByText("3 matches")).toBeVisible();
  // Clearing the text keeps the list open with every project.
  await page.keyboard.press("Backspace");
  const projectList = page.getByRole("listbox", { name: "Project: options" });
  await expect(projectList.getByRole("option", { name: /Notes/ })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(projectList.getByRole("option", { name: /Notes/ })).toContainText(
    "already granted",
  );
  // Arrows skip the granted project; Space checks the active one.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press(" ");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press(" ");
  await expect(projectList.getByRole("option", { selected: true })).toHaveCount(3);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("combobox", { name: "Mode for new items" })).toBeFocused();
  await page.keyboard.press("Enter");
  const modes = page.getByRole("listbox", { name: "Mode for new items: options" });
  await expect(modes).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(modes).toHaveCount(0);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Add 2" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(project).toBeFocused();
  const group = page.locator("#agent-access-projects");
  await expect(
    group.getByRole("combobox", { name: "Folder access for Website" }),
  ).toHaveValue("read");
  await expect(
    group.getByRole("combobox", { name: "Folder access for Wiki" }),
  ).toHaveValue("read");

  // SSH: Enter adds the active host with the chosen mode.
  const ssh = page.getByRole("combobox", { name: "Add SSH/SFTP access" });
  await ssh.focus();
  await page.keyboard.type("nas");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const sshGroup = page.locator("#agent-access-ssh");
  await expect(sshGroup.getByRole("combobox", { name: "Mode for nas-01" })).toHaveValue(
    "approval",
  );
  // Each added item can be changed afterwards.
  await sshGroup
    .getByRole("combobox", { name: "Mode for nas-01" })
    .selectOption("trusted");

  // MCP: Escape closes the list and keeps the focus in the field.
  const mcp = page.getByRole("combobox", { name: "Add MCP server" });
  await mcp.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox", { name: "MCP server: options" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "MCP server: options" })).toHaveCount(0);
  await expect(mcp).toBeFocused();
  await page.keyboard.type("tick");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press(" ");
  await page.keyboard.press("Enter");
  await expect(page.locator("#agent-mcp").getByText("Tickets")).toBeVisible();

  // One save sends the access half (PUT /work) and the MCP servers (PATCH).
  await save(page).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => state.work.length).toBe(1);
  expect(state.work[0].team).toBeUndefined();
  expect(state.work[0].access.projectIds).toEqual(["p1", "p2", "p3"]);
  expect(state.work[0].access.projectFiles).toEqual({ p2: "read", p3: "read" });
  expect(state.work[0].access.sshAccesses).toEqual([
    { accessId: nas.id, mode: "trusted" },
  ]);
  await expect.poll(() => state.updates.length).toBe(1);
  expect(state.updates[0]).toMatchObject({ mcpServers: ["m2"], revision: 1 });

  // Persisted: a reload shows what was saved.
  await page.reload();
  await expect(
    page.locator("#agent-access-projects").getByText("Website", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("#agent-access-ssh").getByRole("combobox", { name: "Mode for nas-01" }),
  ).toHaveValue("trusted");
  await expect(page.locator("#agent-mcp").getByText("Tickets")).toBeVisible();
});

test("a long group shows its first entries and opens the full subpage", async ({
  page,
}) => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    id: `p${i + 10}`,
    name: `Project ${i + 10}`,
    path: `/work/p${i + 10}`,
  }));
  await openAccess(page, {
    catalog: { projects: many, pipelines: [], sshHosts: [], secrets: [] },
    access: { revision: 0, projectIds: many.map((p) => p.id), projectFiles: {} },
  });
  const group = page.locator("#agent-access-projects");
  await expect(group.getByText(/^Project \d+$/)).toHaveCount(5);
  await group.getByRole("link", { name: /3 more/ }).click();
  await expect(page).toHaveURL(/tab=access&page=projects/);
  await expect(page.getByRole("button", { name: "Back to Access" })).toBeVisible();
  // An empty SSH source offers the setup link into Zugänge.
  await page.getByRole("button", { name: "Back to Access" }).click();
  await page
    .locator("#agent-access-ssh")
    .getByRole("link", { name: /Set up SSH accesses/ })
    .click();
  await expect(page).toHaveURL(/\/connections\?section=ssh/);
});

test("removing an entry and leaving asks to keep the Access draft", async ({ page }) => {
  await openAccess(page);
  await page
    .locator("#agent-access-projects")
    .getByRole("button", { name: "Revoke Notes" })
    .click();
  await expect(saveBar(page)).toBeVisible();
  await page.getByRole("tab", { name: "Team", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Save changes?" })).toBeVisible();
});
