import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import {
  connectedChannel,
  emitChange as change,
  home,
  setupAssistantSettings as setup,
} from "../helpers/assistant-settings-browser.js";
import { saveBar, settingsPath, unsavedSheet } from "../helpers/agent-settings-page.js";

const conflict = {
  status: 409,
  error: "Revision conflict",
  messageKey: "assistants.conflict",
};
const name = (page) => page.getByRole("textbox", { name: "Name", exact: true });

test("a profile changed elsewhere can be reloaded", async ({ page }) => {
  const state = await setup(page, { saveFailures: [conflict] });
  await page.goto(baseURL + settingsPath());
  await name(page).fill("Mine");
  await saveBar(page).getByRole("button", { name: "Save agent" }).click();
  await expect(saveBar(page).getByRole("alert")).toContainText(
    "Changed elsewhere in the meantime.",
  );
  expect(state.updates[0]).toMatchObject({ name: "Mine", revision: 1 });
  await saveBar(page).getByRole("button", { name: "Reload", exact: true }).click();
  await expect(name(page)).toHaveValue("Home");
  await expect(saveBar(page)).toHaveCount(0);
});

test("a profile changed elsewhere can be overwritten with the newer revision", async ({
  page,
}) => {
  const state = await setup(page, { saveFailures: [conflict], applyUpdates: true });
  await page.goto(baseURL + settingsPath());
  await name(page).fill("Mine");
  await saveBar(page).getByRole("button", { name: "Save agent" }).click();
  await expect(
    saveBar(page).getByRole("button", { name: "Overwrite anyway" }),
  ).toBeVisible();
  state.assistants = [home({ revision: 4, instructions: "Theirs" })];
  await change(page);
  await expect(page.getByRole("textbox", { name: "Instructions" })).toHaveValue("Theirs");
  await saveBar(page).getByRole("button", { name: "Overwrite anyway" }).click();
  await expect.poll(() => state.updates.length).toBe(2);
  expect(state.updates[1]).toMatchObject({
    name: "Mine",
    instructions: "Theirs",
    revision: 4,
  });
  await expect(saveBar(page)).toHaveCount(0);
});

test("the profile bar shows the apply note and saves name, instructions and model", async ({
  page,
}) => {
  const state = await setup(page, { applyUpdates: true });
  await page.goto(baseURL + settingsPath());
  await expect(saveBar(page)).toHaveCount(0);
  await name(page).fill("Home 2");
  await expect(saveBar(page)).toContainText("Applies before the next message.");
  await saveBar(page).getByRole("button", { name: "Save agent" }).click();
  await expect.poll(() => state.updates.length).toBe(1);
  expect(state.updates[0]).toEqual({
    name: "Home 2",
    instructions: "Plan meals",
    model: { connectionId: "router", modelId: "model" },
    revision: 1,
  });
  await expect(saveBar(page)).toHaveCount(0);
});

test("the Capabilities tab saves switches and MCP servers in one request", async ({
  page,
}) => {
  const state = await setup(page, {
    applyUpdates: true,
    assistant: { mcpServers: [] },
    mcpServers: [{ id: "docs", name: "docs", transport: "http" }],
  });
  await page.goto(baseURL + settingsPath("capabilities"));
  await page.getByRole("switch", { name: "Remember information" }).check();
  await page.getByLabel("docs").check();
  await expect(saveBar(page)).toBeVisible();
  await saveBar(page).getByRole("button", { name: "Save agent" }).click();
  await expect.poll(() => state.updates.length).toBe(1);
  expect(state.updates[0]).toMatchObject({
    revision: 1,
    capabilities: { memory: true },
    mcpServers: ["docs"],
  });
  expect(state.updates[0]).not.toHaveProperty("shell");
  await expect(
    page.getByRole("region", { name: "MCP servers" }).getByRole("status"),
  ).toHaveText("MCP servers saved.");
  await expect(saveBar(page)).toHaveCount(0);
});

test("a task-bound member sees granted MCP servers read-only and the shell reason", async ({
  page,
}) => {
  await setup(page, {
    assistants: [home({ teamMemberId: "m1", lifetime: "task", shell: "approval" })],
  });
  await page.goto(baseURL + settingsPath("capabilities"));
  await expect(page.locator("#agent-shell")).toContainText(
    "Task-bound team members get shell access only when their lead agent allows it under Work, and at most at the lead's level.",
  );
  await expect(page.getByRole("switch", { name: "Remember information" })).toHaveCount(0);
  await expect(saveBar(page)).toHaveCount(0);
});

test("the Work tab saves grants and team policy in one request, then only what changed", async ({
  page,
}) => {
  const state = await setup(page, {
    catalog: {
      projects: [
        { id: "p1", name: "Demo" },
        { id: "p2", name: "Other" },
      ],
      pipelines: [{ id: "b1", name: "Build" }],
    },
  });
  await page.goto(baseURL + settingsPath("work"));
  const projects = page.getByRole("link", { name: /^Allowed projects/ });
  await expect(projects).toContainText("0 of 2");
  await projects.click();
  await page.getByLabel("Demo", { exact: true }).check();
  await expect(unsavedSheet(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Back to Work" }).click();
  await expect(projects).toContainText("1 of 2");
  await page.getByRole("spinbutton", { name: "Maximum team size" }).fill("6");
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.work.length).toBe(1);
  expect(state.work[0]).toEqual({
    access: {
      revision: 0,
      projectIds: ["p1"],
      pipelineIds: [],
      memoryWrite: false,
      autonomous: false,
      publish: false,
    },
    team: {
      revision: 1,
      autonomous: false,
      memberShellSsh: false,
      maxMembers: 6,
      runTimeoutMinutes: 30,
    },
  });
  await expect(saveBar(page)).toHaveCount(0);
  await page.getByRole("spinbutton", { name: "Member time limit (minutes)" }).fill("45");
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.work.length).toBe(2);
  expect(state.work[1]).toEqual({
    team: {
      revision: 2,
      autonomous: false,
      memberShellSsh: false,
      maxMembers: 6,
      runTimeoutMinutes: 45,
    },
  });
});

test("a Telegram save that fails at the channel keeps the edit and retries it", async ({
  page,
}) => {
  const state = await setup(page, {
    applyUpdates: true,
    assistant: { capabilities: { memory: true, reminders: false } },
    channel: connectedChannel(),
    channelFailures: [{ status: 500, error: "Telegram is unavailable" }],
  });
  await page.goto(baseURL + settingsPath("telegram"));
  // Check-ins moved to Routines & check-ins; this tab saves only the channel.
  await expect(page.getByRole("switch", { name: "Check in on its own" })).toHaveCount(0);
  await page.getByLabel("Language of Telegram notices").selectOption("de");
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(saveBar(page).getByRole("alert")).toContainText("Telegram is unavailable");
  expect(state.updates).toHaveLength(0);
  expect(state.channelPatches).toEqual([{ language: "de", revision: 1 }]);
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.channelPatches.length).toBe(2);
  expect(state.updates).toHaveLength(0);
  await expect(saveBar(page)).toHaveCount(0);
});

test("a channel changed elsewhere keeps the edit and can be overwritten", async ({
  page,
}) => {
  const state = await setup(page, { channel: connectedChannel() });
  await page.goto(baseURL + settingsPath("telegram"));
  await page.getByLabel("Language of Telegram notices").selectOption("de");
  state.channel = { ...state.channel, enabled: false, revision: 2 };
  await expect(page.getByRole("button", { name: "Resume Telegram" })).toBeVisible();
  await expect(page.getByLabel("Language of Telegram notices")).toHaveValue("de");
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(saveBar(page).getByRole("alert")).toContainText(
    "Changed elsewhere in the meantime.",
  );
  expect(state.channelPatches).toEqual([{ language: "de", revision: 1 }]);
  await saveBar(page).getByRole("button", { name: "Overwrite anyway" }).click();
  await expect.poll(() => state.channelPatches.length).toBe(2);
  expect(state.channelPatches[1]).toEqual({ language: "de", revision: 2 });
  await expect(saveBar(page)).toHaveCount(0);
});
