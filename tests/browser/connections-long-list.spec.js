import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { settingsPath } from "../helpers/agent-settings-page.js";
import { connectionsFixture, hostId, mcpServer } from "./connections-fixture.js";

// Zugänge long lists (handoff 5.6, AC-ZG-1…4): views, search, filters, groups, sort,
// keyboard, bulk actions with per-item results, and grants that the agent's Access tab
// reads back.

const list = (page) => page.getByRole("region", { name: "SSH/SFTP accesses" });
const rows = (page) => list(page).locator(".long-list-row");
const row = (page, name) => list(page).getByRole("button", { name, exact: true });
const bulk = (page) => page.getByRole("region", { name: "Bulk actions" });
const categories = (page) => page.getByRole("navigation", { name: "Categories" });

test("500 SSH accesses stay a short, grouped list that filters and searches quickly", async ({
  page,
}) => {
  await connectionsFixture(page, { hosts: 500 });
  const started = Date.now();
  await page.goto(baseURL + "/connections?section=ssh");
  await expect(rows(page).first()).toBeVisible();
  expect(Date.now() - started).toBeLessThan(10_000);
  // Categories with counts and problem counts (AC-ZG-1).
  const ssh = categories(page).getByRole("link", { name: /SSH\/SFTP accesses/ });
  await expect(ssh).toHaveAttribute("aria-current", "page");
  await expect(ssh).toContainText("500");
  // Ten failed tests and one changed host key.
  await expect(ssh.locator(".connections-flag")).toHaveText("11");
  // Grouped by project, Global first, five rows each until "Show n more".
  const groups = list(page).locator(".long-list-group-head");
  await expect(groups).toHaveCount(3);
  await expect(groups.first()).toContainText("Global");
  await expect(rows(page)).toHaveCount(15);
  await list(page)
    .getByRole("button", { name: /^Show \d+ more$/ })
    .first()
    .click();
  await expect(rows(page)).toHaveCount(166 + 5 + 5);
  await groups.first().click();
  await expect(groups.first()).toHaveAttribute("aria-expanded", "false");
  await expect(rows(page)).toHaveCount(10);
  await groups.first().click();
  // Views: problems and unused, with their counts.
  await list(page).getByRole("radio", { name: "With problems · 11" }).check();
  await expect(rows(page)).toHaveCount(11);
  await expect(rows(page).first()).toContainText("Test failed");
  await list(page)
    .getByRole("radio", { name: /^Not used · \d+$/ })
    .check();
  await expect(rows(page).first()).toContainText("Not used");
  await list(page).getByRole("radio", { name: "All", exact: true }).check();
  // Search over name, host and user.
  const search = list(page).getByRole("searchbox", { name: "Search the list" });
  await search.fill("server-042");
  await expect(rows(page)).toHaveCount(1);
  await search.fill("10.0.1.");
  await expect(list(page).getByText(/^250 entries in 3 groups/)).toBeVisible();
  await search.fill("admin server-01");
  await expect(rows(page)).toHaveCount(2);
  // A search without matches offers to reset the filters.
  await list(page).getByRole("combobox", { name: "Type" }).selectOption("sftp");
  await search.fill("prd");
  await expect(
    list(page).getByRole("heading", { name: "No matches for “prd”" }),
  ).toBeVisible();
  await expect(list(page).getByText("1 filter active.")).toBeVisible();
  await list(page).getByRole("button", { name: "Reset filters" }).click();
  await expect(search).toHaveValue("");
  await expect(rows(page)).toHaveCount(15);
  // Filter chips combine: global SFTP accesses (every third host).
  await list(page).getByRole("combobox", { name: "Type" }).selectOption("sftp");
  await list(page).getByRole("combobox", { name: "Project" }).selectOption("__global");
  await expect(list(page).getByText(/^166 entries/)).toBeVisible();
  await expect(rows(page).first()).toContainText("SFTP");
  await list(page).getByRole("combobox", { name: "Type" }).selectOption("");
  await list(page).getByRole("combobox", { name: "Project" }).selectOption("");
  // Sort by last use: the one used minutes ago comes first; the note says what counts.
  await list(page).getByRole("combobox", { name: "Group" }).selectOption("none");
  await list(page).getByRole("combobox", { name: "Sort" }).selectOption("used");
  await expect(rows(page).first()).toContainText("server-001");
  await expect(list(page).getByText(/count agents' SSH commands/)).toBeVisible();
  // "Used today" covers today's use only.
  await list(page).getByRole("radio", { name: "Used today" }).check();
  await expect(rows(page)).toHaveCount(1);
});

test("arrow keys move through the rows and Space selects", async ({ page }) => {
  await connectionsFixture(page, { hosts: 8 });
  await page.goto(baseURL + "/connections?section=ssh");
  await list(page).getByRole("combobox", { name: "Group" }).selectOption("none");
  await row(page, "server-000").focus();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, "server-001")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(
    list(page).getByRole("checkbox", { name: "Select server-001" }),
  ).toBeChecked();
  await page.keyboard.press("End");
  await expect(row(page, "server-007")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(bulk(page)).toContainText("2 selected");
  await page.keyboard.press("Enter");
  // Enter opens the detail pane beside the list.
  await expect(
    page.getByRole("article").getByRole("heading", { name: "server-007" }),
  ).toBeVisible();
  await bulk(page).getByRole("button", { name: "Clear selection" }).click();
  await expect(bulk(page)).toHaveCount(0);
});

test("a bulk test runs at most two at once and reports a failure without retrying", async ({
  page,
}) => {
  const state = await connectionsFixture(page, { hosts: 6 });
  state.failingTests.add(hostId(1));
  await page.goto(baseURL + "/connections?section=ssh");
  await list(page).getByRole("combobox", { name: "Group" }).selectOption("none");
  for (const name of ["server-000", "server-001", "server-002"])
    await list(page)
      .getByRole("checkbox", { name: `Select ${name}` })
      .check();
  await bulk(page).getByRole("button", { name: "Test", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Testing 3 accesses" });
  await expect(dialog.getByText("2 done, 1 failed")).toBeVisible();
  await expect(dialog.getByRole("list", { name: "Results" })).toContainText(
    /server-001.*Failed:/,
  );
  const tests = state.sshCalls.filter((call) => call.path.endsWith("/test"));
  expect(tests.map((call) => call.path.split("/").at(-2)).sort()).toEqual(
    [hostId(0), hostId(1), hostId(2)].sort(),
  );
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  // The stored result shows in the list after the run.
  await expect(row(page, "server-001").locator("..")).toContainText("Test failed");
});

test("bulk grant and revoke write the agent's access policy that its Access tab reads", async ({
  page,
}) => {
  const state = await connectionsFixture(page, { hosts: 6 });
  await page.goto(baseURL + "/connections?section=ssh");
  await list(page).getByRole("combobox", { name: "Group" }).selectOption("none");
  await list(page).getByRole("checkbox", { name: "Select server-002" }).check();
  await list(page).getByRole("checkbox", { name: "Select server-004" }).check();
  await bulk(page).getByRole("button", { name: "Grant agent …" }).click();
  const grant = page.getByRole("dialog", { name: "Grant 2 accesses to agents" });
  await grant.getByRole("checkbox", { name: "Home" }).check();
  await grant.getByRole("radio", { name: "Trusted", exact: true }).check();
  await grant.getByRole("button", { name: "Grant to 1 agent" }).click();
  await expect(grant.getByText("1 done")).toBeVisible();
  expect(state.work.at(-1).access.sshAccesses).toEqual([
    { accessId: hostId(2), mode: "trusted" },
    { accessId: hostId(4), mode: "trusted" },
  ]);
  await grant.getByRole("button", { name: "Close", exact: true }).click();
  await expect(row(page, "server-002").locator("..")).toContainText("Home");
  // "Benutzt von" in the detail pane revokes one of them.
  await row(page, "server-004").click();
  const pane = page.locator(".ssh-details");
  await expect(pane.getByRole("combobox", { name: "Mode for Home" })).toHaveValue(
    "trusted",
  );
  await pane.getByRole("button", { name: "Revoke Home" }).click();
  await page
    .getByRole("dialog", { name: "Revoke Home's access to server-004?" })
    .getByRole("button", { name: "Revoke now" })
    .click();
  await expect.poll(() => state.work.length).toBe(2);
  expect(state.work.at(-1).access.sshAccesses).toEqual([
    { accessId: hostId(2), mode: "trusted" },
  ]);
  // The agent's Access tab shows the grant made in Zugänge.
  await page.goto(baseURL + settingsPath("access", "ssh"));
  await expect(page.getByLabel("server-002", { exact: true })).toBeChecked();
  await expect(page.getByLabel("server-004", { exact: true })).not.toBeChecked();
});

test("a grant from the agent's Access tab shows in Benutzt von", async ({ page }) => {
  const state = await connectionsFixture(page, { hosts: 3 });
  await page.goto(baseURL + settingsPath("access", "ssh"));
  await page.getByLabel("server-001", { exact: true }).check();
  await page.getByRole("button", { name: "Back to Access" }).click();
  await page
    .getByRole("region", { name: "Unsaved changes" })
    .getByRole("button", { name: "Save agent", exact: true })
    .click();
  await expect.poll(() => state.work.length).toBe(1);
  await page.goto(baseURL + `/connections?section=ssh&item=${hostId(1)}`);
  const usedBy = page.getByRole("region", { name: /^Used by/ });
  await expect(usedBy.getByRole("combobox", { name: "Mode for Home" })).toHaveValue(
    "approval",
  );
});

test("bulk delete lists who is affected and reports a refused host", async ({ page }) => {
  const state = await connectionsFixture(page, { hosts: 4 });
  state.failingDeletes.add(hostId(3));
  await page.goto(baseURL + "/connections?section=ssh");
  await list(page).getByRole("combobox", { name: "Group" }).selectOption("none");
  await list(page).getByRole("checkbox", { name: "Select server-000" }).check();
  await list(page).getByRole("checkbox", { name: "Select server-003" }).check();
  await bulk(page).getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete 2 SSH/SFTP accesses?" });
  await expect(dialog.locator(".connections-impact")).toContainText("Monitoring");
  await expect(dialog.locator(".connections-impact")).toContainText("Sessions");
  await dialog.getByRole("button", { name: "Delete now" }).click();
  await expect(dialog.getByText("1 done, 1 failed")).toBeVisible();
  await expect(dialog).toContainText("Host is busy");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(row(page, "server-000")).toHaveCount(0);
  await expect(row(page, "server-003")).toBeVisible();
});

test("MCP servers: transport filter, groups by source and per-server results", async ({
  page,
}) => {
  const state = await connectionsFixture(page, {
    hosts: 1,
    mcpServers: [
      mcpServer("docs", "Docs"),
      mcpServer("files", "Files", {
        transport: "stdio",
        url: undefined,
        command: "npx",
        args: ["-y", "files"],
        source: { registry: "npm", name: "files", version: "1.0.0", status: "ready" },
      }),
      mcpServer("notes", "Notes", {
        transport: "stdio",
        url: undefined,
        command: "notes",
      }),
    ],
  });
  state.failingMcpRemove = "notes";
  await page.goto(baseURL + "/connections?section=mcp-servers");
  const mcp = page.getByRole("region", { name: "MCP servers" });
  await expect(mcp.locator(".long-list-group-head")).toHaveText([
    /HTTP · internet/,
    /Packages \(npm, PyPI\)/,
    /Own commands/,
  ]);
  await mcp.getByRole("combobox", { name: "Transport" }).selectOption("stdio");
  await expect(mcp.locator(".long-list-row")).toHaveCount(2);
  await mcp.getByRole("checkbox", { name: "Select all visible" }).check();
  await bulk(page).getByRole("button", { name: "Remove", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Remove 2 MCP servers?" });
  await dialog.getByRole("button", { name: "Remove now" }).click();
  await expect(dialog.getByText("1 done, 1 failed")).toBeVisible();
  await expect(dialog).toContainText("Server is installing");
  expect(state.mcpServers.map((server) => server.id)).toEqual(["docs", "notes"]);
});
