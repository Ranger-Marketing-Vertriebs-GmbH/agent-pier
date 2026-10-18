import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import {
  connectedChannel,
  home,
  setupAssistantSettings as setup,
} from "../helpers/assistant-settings-browser.js";
import {
  agentTab,
  beforeUnloadPrevented,
  saveBar,
  settingsPath,
  unsavedSheet,
} from "../helpers/agent-settings-page.js";

const name = (page) => page.getByRole("textbox", { name: "Name", exact: true });

test("deep links select their tab and junk falls back to the profile", async ({
  page,
}) => {
  await setup(page);
  await page.goto(baseURL + settingsPath("work"));
  await expect(agentTab(page, "Work")).toHaveAttribute("aria-selected", "true");
  await page.goto(baseURL + settingsPath("nope"));
  await expect(page).toHaveURL(/\/agents\/home\/settings$/);
  await expect(agentTab(page, "Profile")).toHaveAttribute("aria-selected", "true");
  await agentTab(page, "Telegram").click();
  await expect(page).toHaveURL(/\/agents\/home\/settings\?tab=telegram$/);
});

test("a task-bound member has two tabs and other tabs normalise without asking", async ({
  page,
}) => {
  await setup(page, { assistants: [home({ teamMemberId: "m1", lifetime: "task" })] });
  await page.goto(baseURL + settingsPath("telegram"));
  await expect(page).toHaveURL(/\/agents\/home\/settings$/);
  await expect(page.getByRole("tab")).toHaveText(["Profile", "Capabilities"]);
  await expect(unsavedSheet(page)).toHaveCount(0);
});

test("switching tabs with unsaved changes asks first", async ({ page }) => {
  const state = await setup(page, { applyUpdates: true });
  await page.goto(baseURL + settingsPath());
  await name(page).fill("Home 2");
  await expect(saveBar(page)).toBeVisible();
  await agentTab(page, "Capabilities").click();
  const sheet = unsavedSheet(page);
  await expect(sheet).toContainText("1 change in Profile is not saved yet.");
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/\/agents\/home\/settings$/);
  await expect(name(page)).toHaveValue("Home 2");
  await agentTab(page, "Capabilities").click();
  await unsavedSheet(page).getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(/tab=capabilities$/);
  expect(state.updates).toEqual([]);
  await agentTab(page, "Profile").click();
  await expect(name(page)).toHaveValue("Home");
  await name(page).fill("Home 3");
  await agentTab(page, "Work").click();
  await unsavedSheet(page).getByRole("button", { name: "Save and switch" }).click();
  await expect(page).toHaveURL(/tab=work$/);
  await expect.poll(() => state.updates.at(-1)?.name).toBe("Home 3");
});

test("going back to the conversation with unsaved changes asks first", async ({
  page,
}) => {
  await setup(page);
  await page.goto(baseURL + settingsPath());
  await name(page).fill("Home 2");
  await page.getByRole("button", { name: "Back to conversation" }).click();
  await unsavedSheet(page).getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/agents\/home\/settings$/);
  await expect(name(page)).toHaveValue("Home 2");
  await page.getByRole("button", { name: "Back to conversation" }).click();
  await unsavedSheet(page).getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(/\/agents\/home\/chats\/c1$/);
});

test("browser back asks first and cancelling keeps the address", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + settingsPath());
  await agentTab(page, "Work").click();
  await agentTab(page, "Profile").click();
  await name(page).fill("Home 2");
  await page.goBack();
  await unsavedSheet(page).getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/agents\/home\/settings$/);
  await expect(name(page)).toHaveValue("Home 2");
});

test("an unsaved tab warns before the page unloads until it is reset", async ({
  page,
}) => {
  await setup(page);
  await page.goto(baseURL + settingsPath());
  expect(await beforeUnloadPrevented(page)).toBe(false);
  await name(page).fill("Home 2");
  await expect.poll(() => beforeUnloadPrevented(page)).toBe(true);
  await saveBar(page).getByRole("button", { name: "Cancel" }).click();
  await expect(name(page)).toHaveValue("Home");
  await expect.poll(() => beforeUnloadPrevented(page)).toBe(false);
});

test("hints sit behind an info disclosure; the shell warning never does", async ({
  page,
}) => {
  await setup(page);
  await page.goto(baseURL + settingsPath("capabilities"));
  const web = page.getByRole("region", { name: "Web & documents" });
  const button = web.getByRole("button", { name: "Show hint" }).first();
  await expect(button).toHaveAttribute("aria-expanded", "false");
  const text = page.locator(`#${await button.getAttribute("aria-controls")}`);
  await expect(text).toBeHidden();
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(text).toHaveText(
    "Web pages can contain instructions meant to mislead the agent. Switch these on only for agents whose other tools you would trust with that.",
  );
  await button.click();
  await expect(text).toBeHidden();
  const shell = page.locator("#agent-shell");
  await shell.getByRole("radio", { name: "With approval" }).check();
  await expect(
    shell.getByText(/With shell access the agent works as your user account/),
  ).toBeVisible();
  await expect(
    shell.getByText(
      "The agent asks you before every command that is not always allowed.",
    ),
  ).toBeVisible();
});

test("switching the note type with unsaved text asks first", async ({ page }) => {
  const state = await setup(page, {
    assistant: { capabilities: { memory: true, reminders: false } },
    memory: {
      "MEMORY.md": { name: "MEMORY.md", content: "Facts", hash: "h1" },
      "USER.md": { name: "USER.md", content: "Tea", hash: "h2" },
    },
  });
  await page.goto(baseURL + settingsPath("capabilities"));
  await page.getByRole("link", { name: /^Saved notes/ }).click();
  await expect(page).toHaveURL(/tab=capabilities&page=memory$/);
  const notes = page.getByLabel("Saved notes");
  await expect(notes).toHaveValue("Facts");
  await notes.fill("Facts and more");
  await page.getByLabel("Note type").selectOption("USER.md");
  const sheet = unsavedSheet(page);
  await expect(sheet).toContainText("1 change in Memory is not saved yet.");
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel("Note type")).toHaveValue("MEMORY.md");
  await expect(notes).toHaveValue("Facts and more");
  await page.getByLabel("Note type").selectOption("USER.md");
  await unsavedSheet(page).getByRole("button", { name: "Save and switch" }).click();
  await expect(notes).toHaveValue("Tea");
  expect(state.memorySaves).toEqual([
    { name: "MEMORY.md", content: "Facts and more", expectedHash: "h1" },
  ]);
  await page.getByRole("button", { name: "Back to Capabilities" }).click();
  await expect(page).toHaveURL(/\/agents\/home\/settings\?tab=capabilities$/);
});

test("a note changed elsewhere can be overwritten against its current hash", async ({
  page,
}) => {
  const state = await setup(page, {
    assistant: { capabilities: { memory: true, reminders: false } },
    memory: { "MEMORY.md": { name: "MEMORY.md", content: "Facts", hash: "h1" } },
  });
  await page.goto(baseURL + settingsPath("capabilities", "memory"));
  const notes = page.getByLabel("Saved notes");
  await expect(notes).toHaveValue("Facts");
  await notes.fill("Mine");
  state.memory["MEMORY.md"] = { name: "MEMORY.md", content: "Theirs", hash: "h9" };
  await saveBar(page).getByRole("button", { name: "Save notes" }).click();
  await expect(saveBar(page).getByRole("alert")).toContainText(
    "Changed elsewhere in the meantime.",
  );
  await expect(notes).toHaveValue("Mine");
  // The page has read the newer hash once the edited note shows as changed elsewhere.
  await expect(
    page.getByRole("status").filter({ hasText: "changed on the server" }),
  ).toBeVisible();
  await saveBar(page).getByRole("button", { name: "Overwrite anyway" }).click();
  await expect.poll(() => state.memorySaves.length).toBe(2);
  expect(state.memorySaves[1]).toEqual({
    name: "MEMORY.md",
    content: "Mine",
    expectedHash: "h9",
  });
  await expect(saveBar(page)).toHaveCount(0);
});

test("the memory page falls back to its tab while memory is off", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + settingsPath("capabilities", "memory"));
  await expect(page).toHaveURL(/\/agents\/home\/settings\?tab=capabilities$/);
  await expect(page.getByRole("link", { name: /^Saved notes/ })).toHaveCount(0);
  await expect(unsavedSheet(page)).toHaveCount(0);
});

test("a capabilities draft survives a visit to its own subpage", async ({ page }) => {
  await setup(page, { assistant: { shell: "approval" } });
  await page.goto(baseURL + settingsPath("capabilities"));
  await page.getByRole("switch", { name: "Read web pages" }).check();
  await page.getByRole("link", { name: /^Always allowed commands/ }).click();
  await expect(unsavedSheet(page)).toHaveCount(0);
  await expect(page.locator("#agent-allowlist")).toContainText(
    "No always allowed commands.",
  );
  await page.getByRole("button", { name: "Back to Capabilities" }).click();
  await expect(page.getByRole("switch", { name: "Read web pages" })).toBeChecked();
  await expect(saveBar(page)).toBeVisible();
});

test("waiting approvals lead to the full action history", async ({ page }) => {
  await setup(page, {
    actions: [
      {
        id: "a1",
        state: "awaiting_approval",
        revision: 1,
        projectName: "Demo",
        payload: { action: "coding_start", title: "Fix it", task: "Fix the bug" },
      },
    ],
  });
  await page.goto(baseURL + settingsPath("work"));
  await page.getByRole("button", { name: /Waiting for your approval · 1/ }).click();
  await expect(page).toHaveURL(/tab=work&page=actions$/);
  const history = page.getByRole("region", { name: "Actions and coding tasks" });
  await expect(history.getByText("Fix the bug")).toBeVisible();
  await expect(history.getByRole("button", { name: "Approve action" })).toBeVisible();
});

test("without Telegram check-ins are offered on their own tab", async ({ page }) => {
  const state = await setup(page, {
    assistant: { capabilities: { memory: true, reminders: false } },
  });
  await page.goto(baseURL + settingsPath("telegram"));
  await expect(page.getByLabel("Telegram bot token")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Check in on its own" })).toHaveCount(0);
  await agentTab(page, "Routines & check-ins").click();
  await expect(page).toHaveURL(/tab=routines$/);
  const checkIn = page.getByRole("switch", { name: "Check in on its own" });
  await expect(checkIn).toBeEnabled();
  await checkIn.check();
  // Without a paired chat there is no Telegram extra to choose.
  await expect(page.getByRole("switch", { name: "Also send to Telegram" })).toHaveCount(
    0,
  );
  await saveBar(page).getByRole("button", { name: "Save" }).click();
  await expect(saveBar(page)).toHaveCount(0);
  expect(state.updates.at(-1).heartbeat).toMatchObject({ enabled: true, telegram: true });
  await expect(page.getByRole("region", { name: "Reminders" })).toHaveCount(0);
  await expect(
    page.getByText("Reminders and routines are off for this agent."),
  ).toBeVisible();
});

test("Telegram activity and connection details open as subpages", async ({ page }) => {
  await setup(page, {
    channel: connectedChannel({
      ignoredMessages: { private: 2, group: 1 },
      inputs: [{ id: "a", state: "reply_unavailable", text: "One" }],
    }),
  });
  await page.goto(baseURL + settingsPath("telegram"));
  const panel = page.getByRole("region", { name: "Telegram" });
  await expect(panel.getByRole("link", { name: /^Telegram activity/ })).toContainText(
    "1 needs your decision",
  );
  await panel.getByRole("link", { name: /^Telegram activity/ }).click();
  await expect(page).toHaveURL(/tab=telegram&page=telegram-activity$/);
  await expect(panel.getByText("One")).toBeVisible();
  await page.getByRole("button", { name: "Back to Telegram" }).click();
  await panel.getByRole("link", { name: /^Connection/ }).click();
  await expect(
    panel.getByText("Ignored messages: 2 from other private chats, 1 from groups."),
  ).toBeVisible();
  await expect(panel.getByLabel("Replace bot token")).toBeVisible();
});

test("reminders open their details in place and are created without Telegram", async ({
  page,
}) => {
  await setup(page, {
    assistant: { capabilities: { memory: false, reminders: true } },
    reminders: [
      {
        id: "r1",
        name: "Water",
        status: "ready",
        enabled: true,
        revision: 1,
        schedule: { kind: "at" },
        nextRunAtMs: Date.UTC(2026, 9, 20, 13, 5),
      },
    ],
  });
  await page.goto(baseURL + settingsPath("routines"));
  const reminders = page.getByRole("region", { name: "Reminders" });
  const add = reminders.getByRole("button", { name: "+ Create reminder" });
  await expect(add).toBeEnabled();
  await expect(reminders).toContainText("in this agent’s chat with a push notification");
  const row = reminders.getByRole("button", { name: /^Water/ });
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(reminders.getByRole("button", { name: "Pause reminder" })).toBeEnabled();
  await expect(reminders.getByRole("button", { name: "Remove reminder" })).toBeEnabled();
  await expect(
    reminders.getByRole("switch", { name: "Also send to Telegram" }),
  ).toHaveCount(0);
  await add.click();
  await expect(reminders.getByLabel("Reminder name")).toBeVisible();
  await expect(page.getByRole("region", { name: "Routines" })).toContainText(
    "No routines yet.",
  );
});

test("with a paired chat each reminder and routine can also go to Telegram", async ({
  page,
}) => {
  const state = await setup(page, {
    assistant: { capabilities: { memory: false, reminders: true } },
    channel: connectedChannel(),
    reminders: [{ id: "r1", name: "Water", status: "ready", enabled: true, revision: 4 }],
    routines: [
      {
        id: "p1",
        name: "Digest",
        prompt: "News",
        status: "ready",
        enabled: true,
        revision: 2,
        telegram: true,
        trigger: { kind: "event", eventKind: "manual" },
      },
    ],
  });
  await page.goto(baseURL + settingsPath("routines"));
  const reminders = page.getByRole("region", { name: "Reminders" });
  await reminders.getByRole("button", { name: /^Water/ }).click();
  // Applied at once: the switch follows the saved reminder.
  const reminderTelegram = reminders.getByRole("switch", {
    name: "Also send to Telegram",
  });
  await reminderTelegram.click();
  await expect(reminderTelegram).toBeChecked();
  await expect
    .poll(() => state.itemPatches)
    .toEqual([["reminders", "r1", { telegram: true, revision: 4 }]]);
  const routines = page.getByRole("region", { name: "Routines" });
  await expect(routines.getByRole("button", { name: /^Digest/ })).toContainText(
    "Also sent to Telegram",
  );
  await routines.getByRole("button", { name: /^Digest/ }).click();
  const routineTelegram = routines.getByRole("switch", { name: "Also send to Telegram" });
  await routineTelegram.click();
  await expect(routineTelegram).not.toBeChecked();
  await expect
    .poll(() => state.itemPatches.at(-1))
    .toEqual(["routines", "p1", { telegram: false, revision: 2 }]);
});

test("creating an agent opens its settings without asking", async ({ page }) => {
  const state = await setup(page);
  await page.route("**/api/assistants", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    state.created = route.request().postDataJSON();
    state.assistants.push(home({ id: "fresh", name: "Fresh" }));
    await route.fulfill({ status: 201, json: state.assistants.at(-1) });
  });
  await page.goto(baseURL + "/agents");
  await page.getByRole("button", { name: "New agent" }).click();
  const create = saveBar(page).getByRole("button", { name: "Create agent" });
  await expect(create).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Fresh");
  await agentTab(page, "Capabilities").click();
  // The five web switches (Create images too) and scheduled check-ins.
  await expect(page.getByText("Available after saving the agent")).toHaveCount(6);
  await page.getByRole("switch", { name: "Remember information" }).check();
  await create.click();
  await expect(page).toHaveURL(/\/agents\/fresh\/settings$/);
  await expect(unsavedSheet(page)).toHaveCount(0);
  expect(state.created).toMatchObject({ name: "Fresh", capabilities: { memory: true } });
});
