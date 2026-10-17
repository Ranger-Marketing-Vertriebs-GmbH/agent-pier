import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import {
  connectedChannel,
  setupAssistantSettings as setup,
} from "../helpers/assistant-settings-browser.js";
import {
  agentTab,
  saveBar,
  settingsPath,
  unsavedSheet,
} from "../helpers/agent-settings-page.js";

const restartRequired = {
  status: 409,
  json: {
    code: "ASSISTANT_RESTART_REQUIRED",
    error: "Restart required",
    affected: { agents: [{ id: "home", name: "Home" }], teamMembers: 0 },
  },
};

test("a save started from a Capabilities subpage shows its confirmation", async ({
  page,
}) => {
  const state = await setup(page, {
    assistant: { shell: "approval" },
    saveFailures: [restartRequired],
    applyUpdates: true,
  });
  await page.goto(baseURL + settingsPath("capabilities"));
  await page.getByRole("switch", { name: "Read web pages" }).check();
  await page.getByRole("link", { name: /^Always allowed commands/ }).click();
  await agentTab(page, "Profile").click();
  await unsavedSheet(page).getByRole("button", { name: "Save and switch" }).click();
  const confirm = page.getByRole("dialog", { name: "Restart the agent service?" });
  await expect(confirm).toBeVisible();
  // Enter must not confirm: Cancel holds the focus.
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Save and restart" }).click();
  await expect.poll(() => state.updates.length).toBe(2);
  expect(state.updates[1]).toMatchObject({ confirmRestart: true });
  await expect(page).toHaveURL(/\/agents\/home\/settings$/);
  await expect(saveBar(page)).toHaveCount(0);
});

test("an empty or out-of-range team number blocks the save with a field error", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto(baseURL + settingsPath("work"));
  const size = page.getByRole("spinbutton", { name: "Maximum team size" });
  await size.fill("");
  await expect(size).toHaveAccessibleDescription("Enter a whole number from 1 to 8.");
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await size.fill("9");
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await agentTab(page, "Profile").click();
  await unsavedSheet(page).getByRole("button", { name: "Save and switch" }).click();
  await expect(page).toHaveURL(/tab=work$/);
  expect(state.work).toEqual([]);
  await size.fill("8");
  await expect(size).toHaveAccessibleDescription("");
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.work.length).toBe(1);
  expect(state.work[0].team).toMatchObject({ maxMembers: 8 });
});

test("a team policy changed elsewhere is overwritten with its newer revision", async ({
  page,
}) => {
  const state = await setup(page, {
    catalog: { projects: [], pipelines: [{ id: "b1", name: "Build" }] },
  });
  await page.goto(baseURL + settingsPath("work"));
  await expect(page.getByRole("link", { name: /^Allowed pipelines/ })).toContainText(
    "0 of 1",
  );
  await page.getByRole("spinbutton", { name: "Maximum team size" }).fill("6");
  // Changed elsewhere without an event: only the refresh after the 409 can see it.
  state.policies.home = { ...state.policies.home, revision: 5, runTimeoutMinutes: 40 };
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(saveBar(page).getByRole("alert")).toContainText(
    "Changed elsewhere in the meantime.",
  );
  await saveBar(page).getByRole("button", { name: "Overwrite anyway" }).click();
  await expect.poll(() => state.work.length).toBe(2);
  expect(state.work[1].team).toEqual({
    revision: 5,
    autonomous: false,
    memberShellSsh: false,
    maxMembers: 6,
    runTimeoutMinutes: 40,
  });
  await expect(saveBar(page)).toHaveCount(0);
});

test("a failed Work reload after a conflict shows an error", async ({ page }) => {
  const state = await setup(page);
  await page.goto(baseURL + settingsPath("work"));
  await page
    .getByRole("switch", {
      name: "Allow selected pipelines to publish pull requests",
    })
    .check();
  state.access = { ...state.access, revision: 3 };
  state.accessFailures = 1;
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(saveBar(page).getByRole("alert")).toContainText(
    "Changed elsewhere in the meantime.",
  );
  await expect(page.locator("#agent-access").getByRole("alert")).toHaveText(
    "Access unavailable",
  );
});

test("a disconnected channel keeps its activity and drops its unsaved fields", async ({
  page,
}) => {
  const state = await setup(page, {
    channel: connectedChannel({
      inputs: [{ id: "a", state: "reply_unavailable", text: "One" }],
    }),
  });
  await page.goto(baseURL + settingsPath("telegram"));
  await page.getByLabel("Language of Telegram notices").selectOption("de");
  await expect(saveBar(page)).toBeVisible();
  await page.getByRole("button", { name: "Disconnect bot" }).click();
  await expect(page.getByLabel("Telegram bot token")).toBeVisible();
  await expect(saveBar(page)).toHaveCount(0);
  const panel = page.getByRole("region", { name: "Telegram" });
  await expect(panel.getByRole("link", { name: /^Telegram activity/ })).toContainText(
    "1 needs your decision",
  );
  await panel.getByRole("link", { name: /^Telegram activity/ }).click();
  await expect(unsavedSheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(/tab=telegram&page=telegram-activity$/);
  await expect(panel.getByText("One")).toBeVisible();
  expect(state.channelPatches).toEqual([]);
});

test("a Telegram subpage link for an agent without a channel opens the tab", async ({
  page,
}) => {
  await setup(page);
  await page.goto(baseURL + settingsPath("telegram", "telegram-connection"));
  await expect(page).toHaveURL(/\/agents\/home\/settings\?tab=telegram$/);
  await expect(page.getByLabel("Telegram bot token")).toBeVisible();
  await expect(unsavedSheet(page)).toHaveCount(0);
});

test("an agent without a name is not sent", async ({ page }) => {
  const state = await setup(page);
  await page.goto(baseURL + settingsPath());
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("");
  await saveBar(page).getByRole("button", { name: "Save agent" }).click();
  await agentTab(page, "Work").click();
  await unsavedSheet(page).getByRole("button", { name: "Save and switch" }).click();
  await expect(page).toHaveURL(/\/agents\/home\/settings$/);
  expect(state.updates).toEqual([]);
});

test("generated instructions are marked as reviewed only without unsaved edits", async ({
  page,
}) => {
  await setup(page, { assistant: { instructionsSource: "model" } });
  await page.goto(baseURL + settingsPath());
  const review = page.getByRole("button", { name: "Mark as reviewed" });
  await expect(review).toBeEnabled();
  await page.getByRole("textbox", { name: "Instructions" }).fill("Mine");
  await expect(review).toBeDisabled();
});

test("a saved check-in schedule shows on and can be switched off without Telegram", async ({
  page,
}) => {
  const state = await setup(page, {
    applyUpdates: true,
    assistant: {
      capabilities: { memory: true, reminders: false },
      heartbeat: { enabled: true, interval: "4h", start: 9, end: 18, timeZone: "UTC" },
    },
  });
  await page.goto(baseURL + settingsPath("telegram"));
  const checkIns = page.getByRole("switch", { name: "Check in on its own" });
  await expect(checkIns).toBeChecked();
  await checkIns.uncheck();
  await expect(checkIns).toBeDisabled();
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.updates.length).toBe(1);
  expect(state.updates[0].heartbeat.enabled).toBe(false);
});
