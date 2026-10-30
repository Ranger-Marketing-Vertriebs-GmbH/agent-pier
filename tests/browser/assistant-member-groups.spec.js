import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture } from "../helpers/assistant-chat-fixture.js";
import { settingsPath } from "../helpers/agent-settings-page.js";

// A lead ("home") with three permanent members: Scout and Writer in its group
// "Research", Coder without a group. The owner sees them grouped in the sidebar and
// manages the groups in the lead's Team tab (AGENTPIER-283).
const words = {
  en: {
    show: "Show team members (3)",
    permanent: "Permanent",
    research: "Research, 2 members",
    twoMembers: "2 members",
    groups: "Groups",
    newGroup: "New group",
    name: "Group name",
    create: "Create",
    ungrouped: "No group",
    member: (name) => `Change the group of ${name}`,
    group: (name) => `Actions for group ${name}`,
    takeOut: "Remove from group",
    rename: "Rename …",
    renameTo: "Rename",
    remove: "Delete group",
    removeTitle: "Delete group “Scouts”?",
  },
  de: {
    show: "Teammitglieder anzeigen (3)",
    permanent: "Dauerhaft",
    research: "Research, 2 Mitglieder",
    twoMembers: "2 Mitglieder",
    groups: "Gruppen",
    newGroup: "Neue Gruppe",
    name: "Name der Gruppe",
    create: "Erstellen",
    ungrouped: "Ohne Gruppe",
    member: (name) => `Gruppe von ${name} ändern`,
    group: (name) => `Aktionen für Gruppe ${name}`,
    takeOut: "Aus der Gruppe nehmen",
    rename: "Umbenennen …",
    renameTo: "Umbenennen",
    remove: "Gruppe löschen",
    removeTitle: "Gruppe „Scouts“ löschen?",
  },
};
const names = { scout: "Scout", writer: "Writer", coder: "Coder" };
const agent = (id) =>
  chatAssistant({
    id,
    name: names[id],
    teamMemberId: id,
    teamId: "crew",
    parentAssistantId: "home",
    lifetime: "permanent",
  });
const record = (id) => ({
  id,
  kind: "member",
  revision: 1,
  teamId: "crew",
  parentAssistantId: "home",
  assistantId: id,
  name: names[id],
  role: `${names[id]} role`,
  assignment: `${names[id]} works`,
  lifetime: "permanent",
  phase: "completed",
  conversationId: `${id}-chat`,
});

async function setup(page, language) {
  const ids = Object.keys(names);
  const state = await chatFixture(page, {
    language,
    assistants: [chatAssistant(), ...ids.map(agent)],
    conversations: [
      { id: "dinner", assistantId: "home" },
      ...ids.map((id) => ({ id: `${id}-chat`, assistantId: id })),
    ],
    members: ids.map(record),
    groups: [
      {
        id: "research",
        kind: "member-group",
        revision: 1,
        parentAssistantId: "home",
        name: "Research",
        memberIds: ["scout", "writer"],
        createdAt: "2026-10-30T09:00:00.000Z",
      },
    ],
  });
  state.groupCalls = [];
  // The owner's group changes, applied to the list as the server would.
  await page.route(
    /\/api\/(assistants\/home\/member-groups|assistant-member-groups\/[^/]+|assistant-team-members\/[^/]+\/group)$/,
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace("/api/", "");
      const body = request.postDataJSON?.() ?? null;
      state.groupCalls.push(`${request.method()} ${path}`);
      const [, id] = path.split("/");
      if (path === "assistants/home/member-groups") {
        const group = {
          id: body.name.toLowerCase(),
          kind: "member-group",
          revision: 1,
          parentAssistantId: "home",
          name: body.name,
          memberIds: [],
          createdAt: new Date().toISOString(),
        };
        state.groups.push(group);
        return route.fulfill({ json: group });
      }
      if (path.endsWith("/group")) {
        // One step: out of every group, into the new one.
        for (const g of state.groups) g.memberIds = g.memberIds.filter((m) => m !== id);
        state.groups.find((g) => g.id === body.groupId)?.memberIds.push(id);
        return route.fulfill({ json: { memberId: id, groupId: body.groupId } });
      }
      const group = state.groups.find((g) => g.id === id);
      if (request.method() === "DELETE") {
        state.groups = state.groups.filter((g) => g !== group);
        return route.fulfill({ json: { deleted: id } });
      }
      group.name = body.name;
      return route.fulfill({ json: group });
    },
  );
  return state;
}
const teamTab = baseURL + settingsPath("team");
const groupsSection = (page) => page.locator("#agent-member-groups");
const card = (page, name) =>
  groupsSection(page).getByRole("group", { name, exact: true });
const fits = async (page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);

for (const language of ["en", "de"])
  test.describe(`member groups (${language})`, () => {
    const w = words[language];
    test.beforeEach(({ page }) => page.setViewportSize({ width: 1440, height: 1600 }));

    test("the sidebar shows permanent members under their groups", async ({ page }) => {
      await setup(page, language);
      await page.goto(baseURL + "/agents/home/chats/dinner");
      const sidebar = page.locator(".assistant-chats-group");
      await sidebar.getByRole("button", { name: w.show }).click();
      const research = sidebar.getByRole("group", { name: w.research, exact: true });
      await expect(research.locator(".assistant-sidebar-assignment")).toContainText(
        "Research",
      );
      await expect(research.locator(".assistant-sidebar-assignment")).toContainText(
        w.twoMembers,
      );
      await expect(research.locator(".assistant-sidebar-member")).toHaveCount(2);
      await expect(research).toContainText("Scout");
      await expect(research).toContainText("Writer");
      const ungrouped = sidebar.getByRole("group", { name: w.permanent, exact: true });
      await expect(ungrouped.locator(".assistant-sidebar-member")).toHaveCount(1);
      await expect(ungrouped).toContainText("Coder");
      await expect(sidebar.locator(".assistant-sidebar-section")).toHaveText([
        w.permanent,
      ]);
      await fits(page);
    });

    test("the owner creates, moves, renames and deletes groups in the Team tab", async ({
      page,
    }) => {
      const state = await setup(page, language);
      await page.goto(teamTab);
      const section = groupsSection(page);
      await expect(section.getByRole("heading", { name: w.groups })).toBeVisible();
      await expect(card(page, "Research")).toContainText("Scout");
      await expect(card(page, w.ungrouped)).toContainText("Coder");
      // A new group, created from the section's head.
      await section.getByRole("button", { name: w.newGroup, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: w.newGroup });
      await dialog.getByLabel(w.name).fill("Build");
      await dialog.getByRole("button", { name: w.create, exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(card(page, "Build")).toBeVisible();
      // Ungrouped → Build.
      await page.getByRole("button", { name: w.member("Coder") }).click();
      await page.getByRole("menuitemradio", { name: "Build" }).click();
      await expect(card(page, "Build")).toContainText("Coder");
      await expect(card(page, w.ungrouped)).toHaveCount(0);
      // Research → Build directly: the menu marks its current group.
      await page.getByRole("button", { name: w.member("Scout") }).click();
      await expect(page.getByRole("menuitemradio", { name: "Research" })).toBeChecked();
      await page.getByRole("menuitemradio", { name: "Build" }).click();
      await expect(card(page, "Build")).toContainText("Scout");
      await expect(card(page, "Research")).not.toContainText("Scout");
      // Out of a group, back to the members without one.
      await page.getByRole("button", { name: w.member("Writer") }).click();
      await page.getByRole("menuitem", { name: w.takeOut }).click();
      await expect(card(page, w.ungrouped)).toContainText("Writer");
      expect(state.groupCalls).toEqual([
        "POST assistants/home/member-groups",
        "PUT assistant-team-members/coder/group",
        "PUT assistant-team-members/scout/group",
        "PUT assistant-team-members/writer/group",
      ]);
      // Rename the now empty Research group, then delete it.
      await page.getByRole("button", { name: w.group("Research") }).click();
      await page.getByRole("menuitem", { name: w.rename }).click();
      const rename = page.getByRole("dialog");
      await rename.getByLabel(w.name).fill("Scouts");
      await rename.getByRole("button", { name: w.renameTo, exact: true }).click();
      await expect(card(page, "Scouts")).toBeVisible();
      await page.getByRole("button", { name: w.group("Scouts") }).click();
      await page.getByRole("menuitem", { name: w.remove }).click();
      const confirm = page.getByRole("dialog", { name: w.removeTitle });
      await confirm.getByRole("button", { name: w.remove, exact: true }).click();
      await expect(card(page, "Scouts")).toHaveCount(0);
      expect(state.groupCalls.slice(-2)).toEqual([
        "PATCH assistant-member-groups/research",
        "DELETE assistant-member-groups/research",
      ]);
      await fits(page);
    });

    test("a new group from a member's menu takes that member along", async ({ page }) => {
      const state = await setup(page, language);
      await page.goto(teamTab);
      await page.getByRole("button", { name: w.member("Coder") }).click();
      await page
        .getByRole("menuitem", {
          name: language === "en" ? "New group …" : "Neue Gruppe …",
        })
        .click();
      const dialog = page.getByRole("dialog", { name: w.newGroup });
      await dialog.getByLabel(w.name).fill("Ops");
      await dialog.getByRole("button", { name: w.create, exact: true }).click();
      await expect(card(page, "Ops")).toContainText("Coder");
      expect(state.groupCalls).toEqual([
        "POST assistants/home/member-groups",
        "PUT assistant-team-members/coder/group",
      ]);
    });
  });
