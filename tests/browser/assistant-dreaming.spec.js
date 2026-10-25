import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { settingsPath } from "../helpers/agent-settings-page.js";
import { home, setupAssistantSettings } from "../helpers/assistant-settings-browser.js";

test.use({ locale: "en-GB", timezoneId: "Europe/Berlin" });

// Set AGENTPIER_SHOTS_DIR to a directory to keep screenshots of the states.
const shots = process.env.AGENTPIER_SHOTS_DIR;
const shoot = (target, name) =>
  shots ? target.screenshot({ path: `${shots}/${name}.png` }) : null;

const fern = (memory) =>
  home({ name: "Fern", capabilities: { memory, reminders: false } });

// The dreaming route as the server answers it (assistant-dreaming.js).
async function setup(page, { enabled = false, memoryOn = false, ...options } = {}) {
  const state = await setupAssistantSettings(page, {
    assistants: [fern(memoryOn)],
    ...options,
  });
  state.dreaming = { revision: 1, enabled, hour: 3, timeZone: "UTC" };
  state.dreamingPuts = [];
  const view = () => ({
    ...state.dreaming,
    withoutMemory: state.assistants
      .filter((agent) => agent.capabilities.memory !== true)
      .map(({ id, name }) => ({ id, name })),
  });
  await page.route("**/api/assistant-dreaming", (route) => {
    if (route.request().method() !== "PUT") return route.fulfill({ json: view() });
    const { revision, confirmMemory, ...body } = route.request().postDataJSON();
    state.dreamingPuts.push({ revision, confirmMemory, ...body });
    if (revision !== state.dreaming.revision)
      return route.fulfill({
        status: 409,
        json: { error: "Revision conflict", messageKey: "assistants.conflict" },
      });
    const agents = view().withoutMemory;
    if (body.enabled && agents.length && confirmMemory !== true)
      return route.fulfill({
        status: 409,
        json: {
          code: "ASSISTANT_DREAMING_MEMORY_CONFIRMATION_REQUIRED",
          error: "Dreaming needs memory.",
          messageKey: "assistants.dreamingMemoryConfirm",
          agents,
        },
      });
    if (body.enabled)
      state.assistants = state.assistants.map((agent) => ({
        ...agent,
        revision: agent.revision + 1,
        capabilities: { ...agent.capabilities, memory: true },
      }));
    state.dreaming = { ...body, revision: revision + 1 };
    return route.fulfill({ json: view() });
  });
  return state;
}

test("switching dreaming on confirms the agents without memory", async ({ page }) => {
  const state = await setup(page);
  await page.goto(baseURL + "/settings/assistants");
  const group = page.getByRole("region", { name: "Dreaming" });
  await group.getByRole("switch", { name: "Dream at night" }).check();
  await expect(group.getByRole("combobox", { name: "Time" })).toHaveValue("3");
  await expect(group).toContainText("Europe/Berlin");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Turn memory on for these agents?" });
  await expect(dialog).toContainText("1 permanent agents do not remember");
  await expect(dialog).toContainText("Fern");
  await shoot(page, "dreaming-confirm");
  await dialog.getByRole("button", { name: "Turn on memory and dreaming" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Unsaved changes" })).toHaveCount(0);
  expect(state.dreamingPuts.map((put) => put.confirmMemory)).toEqual([undefined, true]);
  expect(state.dreaming).toMatchObject({
    enabled: true,
    hour: 3,
    timeZone: "Europe/Berlin",
  });
  await shoot(group, "dreaming-settings");
  await page.setViewportSize({ width: 390, height: 844 });
  await group.scrollIntoViewIfNeeded();
  await shoot(page, "dreaming-settings-phone");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL + settingsPath("capabilities"));
  const memory = page.getByRole("switch", { name: "Remember information" });
  await expect(memory).toBeChecked();
  await expect(memory).toBeDisabled();
  await expect(
    page.getByText("Dreaming is on: every permanent agent keeps"),
  ).toBeVisible();
  await shoot(page, "memory-locked");
});

test("the hour change saves without a confirmation", async ({ page }) => {
  const state = await setup(page, { enabled: true, memoryOn: true });
  await page.goto(baseURL + "/settings/assistants");
  const group = page.getByRole("region", { name: "Dreaming" });
  await group.getByRole("combobox", { name: "Time" }).selectOption("5");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("region", { name: "Unsaved changes" })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.dreamingPuts).toEqual([
    { revision: 1, confirmMemory: undefined, enabled: true, hour: 5, timeZone: "UTC" },
  ]);
});

test("the Dream Diary opens read only", async ({ page }) => {
  await setup(page, {
    enabled: true,
    memoryOn: true,
    memory: {
      "DREAMS.md": {
        name: "DREAMS.md",
        content: "# Dream Diary\n\nA calm night of sorting notes.",
        hash: "d1",
        readOnly: true,
      },
    },
  });
  await page.route("**/api/assistants/home/memory/files", (route) =>
    route.fulfill({
      json: {
        files: [
          {
            name: "DREAMS.md",
            diary: true,
            size: 40,
            modifiedAt: "2026-10-25T03:10:00Z",
          },
          { name: "memory/dreaming/light/2026-10-25.md", size: 20 },
        ],
      },
    }),
  );
  await page.goto(baseURL + settingsPath("capabilities", "memory"));
  const type = page.getByRole("combobox", { name: "Note type" });
  await type.selectOption({ label: "Dream Diary" });
  const notes = page.getByRole("textbox", { name: "Notes" });
  await expect(notes).toHaveValue(/A calm night of sorting notes/);
  await expect(notes).toHaveAttribute("readonly", "");
  await expect(page.getByText("Written by the agent's nightly dreaming.")).toBeVisible();
  await expect(
    page.getByRole("option", { name: "memory/dreaming/light/2026-10-25.md" }),
  ).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Clear draft" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save notes" })).toHaveCount(0);
  await shoot(page, "dream-diary");
});
