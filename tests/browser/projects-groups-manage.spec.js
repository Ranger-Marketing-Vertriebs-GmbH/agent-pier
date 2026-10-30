import { test, expect } from "../helpers/browser-test.js";
import { baseURL as base } from "../helpers/browser.js";
import { projectList, section, groupsFixture } from "./projects-groups-fixture.js";

// Renaming, reordering and deleting project groups, in English.
test.use({ locale: "en-GB" });

const seeded = (server) => {
  server.document = {
    version: 3,
    groups: [
      { id: "g_1", name: "Clients" },
      { id: "g_2", name: "Games" },
      { id: "g_3", name: "Empty" },
    ],
    assignments: { "/work/notes": "g_1" },
  };
};
const actions = (page, name) =>
  page.getByRole("button", { name: `Actions for group ${name}` });
const menuItem = (page, name) => page.getByRole("menuitem", { name, exact: true });
const headers = (page) => projectList(page).locator(".project-section-title");

test("a group is renamed inline; empty and duplicate names are refused", async ({
  page,
}) => {
  const { server } = await groupsFixture(page);
  seeded(server);
  await page.goto(base + "/projects");
  await expect(section(page, "Clients")).toBeVisible();
  await expect(
    projectList(page).getByRole("button", { name: /^Actions for group / }),
  ).toHaveCount(3);

  await actions(page, "Clients").click();
  await menuItem(page, "Rename").click();
  const name = page.getByRole("textbox", { name: "Group name" });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("Clients");
  await name.fill(" ");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter a name for the group.");
  await name.fill("games");
  await name.press("Enter");
  await expect(page.getByRole("alert")).toHaveText(
    "A group with this name already exists.",
  );
  // Its own name (changing only the case) is fine; Escape cancels and returns focus.
  await name.fill("CLIENTS");
  await name.press("Enter");
  await expect(name).toHaveCount(0);
  await expect(actions(page, "CLIENTS")).toBeFocused();
  expect(server.puts.at(-1).groups[0]).toEqual({ id: "g_1", name: "CLIENTS" });

  await actions(page, "CLIENTS").click();
  await menuItem(page, "Rename").click();
  await name.fill("Never saved");
  await name.press("Escape");
  await expect(actions(page, "CLIENTS")).toBeFocused();
  expect(server.puts).toHaveLength(1);
});

test("groups move up and down; the ends hide the impossible direction", async ({
  page,
}) => {
  const { server } = await groupsFixture(page);
  seeded(server);
  await page.goto(base + "/projects");
  await expect(headers(page)).toHaveText(["Clients", "Games", "Empty", "No group"]);

  await actions(page, "Clients").click();
  await expect(menuItem(page, "Move up")).toHaveCount(0);
  await menuItem(page, "Move down").click();
  await expect(headers(page)).toHaveText(["Games", "Clients", "Empty", "No group"]);
  await expect(actions(page, "Clients")).toBeFocused();
  expect(server.puts.at(-1).groups.map((group) => group.id)).toEqual([
    "g_2",
    "g_1",
    "g_3",
  ]);

  await actions(page, "Empty").click();
  await expect(menuItem(page, "Move down")).toHaveCount(0);
  await menuItem(page, "Move up").click();
  await expect(headers(page)).toHaveText(["Games", "Empty", "Clients", "No group"]);
});

test("deleting a group with projects asks first; they land in No group", async ({
  page,
}) => {
  const { server } = await groupsFixture(page);
  seeded(server);
  await page.goto(base + "/projects");
  await actions(page, "Clients").click();
  await menuItem(page, "Delete group").click();
  const dialog = page.getByRole("dialog", { name: "Delete group “Clients”?" });
  await expect(dialog).toContainText(
    "1 project moves to “No group”. No files are changed.",
  );
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(section(page, "Clients")).toBeVisible();
  expect(server.puts).toHaveLength(0);

  await actions(page, "Clients").click();
  await menuItem(page, "Delete group").click();
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(headers(page)).toHaveText(["Games", "Empty", "No group"]);
  await expect(section(page, "No group")).toHaveText(/No group\s*2/);
  await expect(page.getByRole("button", { name: /^Games\s*\d+$/ })).toBeFocused();
  expect(server.puts.at(-1)).toEqual({
    version: 3,
    groups: [
      { id: "g_2", name: "Games" },
      { id: "g_3", name: "Empty" },
    ],
    assignments: {},
  });
});

test("an empty group is deleted without a confirmation", async ({ page }) => {
  const { server } = await groupsFixture(page);
  seeded(server);
  await page.goto(base + "/projects");
  await actions(page, "Empty").click();
  await menuItem(page, "Delete group").click();
  await expect(headers(page)).toHaveText(["Clients", "Games", "No group"]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(server.puts.at(-1).groups.map((group) => group.id)).toEqual(["g_1", "g_2"]);
});

test("deleting the last group moves focus to the No group header", async ({ page }) => {
  const { server } = await groupsFixture(page);
  seeded(server);
  await page.goto(base + "/projects");
  // Empty path: no confirmation.
  await actions(page, "Empty").click();
  await menuItem(page, "Delete group").click();
  await expect(headers(page)).toHaveText(["Clients", "Games", "No group"]);
  await expect(section(page, "No group")).toBeFocused();
  await actions(page, "Games").click();
  await menuItem(page, "Delete group").click();
  await expect(section(page, "No group")).toBeFocused();
  // Populated path: the confirmation, then focus on the header that follows.
  await actions(page, "Clients").click();
  await menuItem(page, "Delete group").click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(headers(page)).toHaveText(["No group"]);
  await expect(section(page, "No group")).toBeFocused();
});
