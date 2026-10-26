import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import {
  home,
  setupAssistantSettings as setup,
} from "../helpers/assistant-settings-browser.js";
import { agentTab, settingsPath } from "../helpers/agent-settings-page.js";

// AC-AS-4: temporary members and agents of users show the right tabs and locks.
const catalog = {
  projects: [{ id: "p1", name: "Notes", path: "/work/notes" }],
  pipelines: [{ id: "pl1", name: "Factory" }],
  sshHosts: [],
  secrets: [],
};

test("a temporary member reads its lead's grants in Access and edits none", async ({
  page,
}) => {
  await setup(page, {
    assistants: [
      home({
        teamMemberId: "m1",
        lifetime: "task",
        inherited: { capabilities: { webSearch: true }, skills: [], shell: "off" },
      }),
    ],
    catalog,
  });
  await page.goto(baseURL + settingsPath("access"));
  await expect(page.getByRole("tab")).toHaveText([
    "Overview",
    "Identity",
    "Capabilities",
    "Access",
  ]);
  await expect(agentTab(page, "Access")).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("region", { name: "Granted by the lead agent" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Shared by the lead agent" }),
  ).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveCount(0);
  // Its own memory stays under Capabilities; the grants moved out.
  await agentTab(page, "Capabilities").click();
  await expect(page.getByRole("link", { name: /^Own memory/ })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Granted by the lead agent" }),
  ).toHaveCount(0);
});

test("an agent of users has no Team tab and keeps project folders only", async ({
  page,
}) => {
  await setup(page, {
    assistants: [
      home({
        userAccess: { mode: "shared", members: [{ userId: "u1", level: "chat" }] },
        mcpServers: [],
      }),
    ],
    mcpServers: [],
    catalog,
  });
  await page.goto(baseURL + settingsPath("work", "ssh"));
  // A locked page falls back to the tab with its lock notice.
  await expect(page).toHaveURL(/tab=access$/);
  await expect(page.getByRole("tab")).toHaveText([
    "Overview",
    "Identity",
    "Capabilities",
    "Access",
    "Automation",
    "Channels",
  ]);
  await expect(page.getByRole("combobox", { name: "Add Project" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Add SSH/SFTP access" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("combobox", { name: "Add Pipeline" })).toHaveCount(0);
  await expect(
    page.getByRole("note").filter({ hasText: "Locked: Pipelines" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Who uses this agent" })).toBeVisible();
  await page.goto(baseURL + settingsPath("team"));
  await expect(agentTab(page, "Overview")).toHaveAttribute("aria-selected", "true");
  await agentTab(page, "Capabilities").click();
  await expect(page.getByRole("note").filter({ hasText: "Locked: Shell" })).toBeVisible();
});
