import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { setupAssistantSettings as setup } from "../helpers/assistant-settings-browser.js";

test.use({ timezoneId: "Europe/Berlin" });
const section = (page) => page.locator("#agent-proactivity");

test("check-ins are off, need memory, explain their cost and save", async ({ page }) => {
  const state = await setup(page);
  await page.goto(baseURL + "/agents/home/settings");
  const proactivity = section(page);
  await expect(
    proactivity.getByRole("group", { name: "Acting on its own" }),
  ).toBeVisible();
  // Recall across conversations is not offered in this release.
  await expect(page.getByText("Remember across conversations")).toHaveCount(0);
  const heartbeat = proactivity.getByRole("checkbox", { name: "Check in on its own" });
  await expect(heartbeat).not.toBeChecked();
  await expect(heartbeat).toBeDisabled();
  await expect(proactivity).toContainText("Needs memory to be switched on above.");
  await page.getByRole("checkbox", { name: /^Remember information/ }).check();
  await expect(heartbeat).toBeEnabled();
  await expect(proactivity).toContainText("paired Telegram chat");
  await heartbeat.check();
  await expect(proactivity).toContainText(
    "Check-ins appear in the agent's chat, marked “Check-in:” on Telegram",
  );
  await proactivity.getByLabel("How often").selectOption("2h");
  await proactivity.getByLabel("Active from").selectOption("8");
  await proactivity.getByLabel("Active until").selectOption("20");
  await expect(proactivity).toContainText(
    "Times in Europe/Berlin, within one day. About 6 extra model runs per day, each reading the whole conversation.",
  );
  // The browser's zone is the saved one: nothing to adopt.
  await expect(proactivity.getByRole("button", { name: /Use my time zone/ })).toHaveCount(
    0,
  );
  await proactivity.getByLabel("How often").selectOption("daily");
  await expect(proactivity).toContainText("About 1 extra model run per day");
  await proactivity.getByLabel("How often").selectOption("1h");
  await expect(proactivity).toContainText("About 12 extra model runs per day");
  await proactivity.screenshot({ path: ".cache/assistant-proactivity-desktop-en.png" });
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect.poll(() => state.updates.length).toBe(1);
  expect(state.updates[0].capabilities.memory).toBe(true);
  expect(state.updates[0].capabilities).not.toHaveProperty("recall");
  expect(state.updates[0].heartbeat).toEqual({
    enabled: true,
    interval: "1h",
    start: 8,
    end: 20,
    timeZone: "Europe/Berlin",
  });
});

test("switching memory off also switches check-ins off", async ({ page }) => {
  const state = await setup(page, {
    assistant: {
      capabilities: { memory: true, reminders: false },
      heartbeat: { enabled: true, interval: "4h", start: 9, end: 18, timeZone: "UTC" },
    },
  });
  await page.goto(baseURL + "/agents/home/settings");
  await page.getByRole("checkbox", { name: /^Remember information/ }).uncheck();
  await expect(
    section(page).getByRole("checkbox", { name: "Check in on its own" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect.poll(() => state.updates.length).toBe(1);
  expect(state.updates[0].heartbeat.enabled).toBe(false);
});

test("an agent's saved check-ins load into the form and fit a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, {
    assistant: {
      capabilities: { memory: true, reminders: true },
      heartbeat: {
        enabled: true,
        interval: "4h",
        start: 9,
        end: 21,
        timeZone: "America/New_York",
      },
    },
  });
  await page.goto(baseURL + "/agents/home/settings");
  const proactivity = section(page);
  await expect(proactivity.getByLabel("How often")).toHaveValue("4h");
  // The saved zone is kept until the owner adopts the browser's.
  await expect(proactivity).toContainText(
    "Times in America/New_York, within one day. About 3 extra model runs per day",
  );
  await proactivity.screenshot({ path: ".cache/assistant-proactivity-zone-en.png" });
  await proactivity
    .getByRole("button", { name: "Use my time zone (Europe/Berlin)" })
    .click();
  await expect(proactivity).toContainText("Times in Europe/Berlin, within one day.");
  const box = await proactivity.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await proactivity.scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".cache/assistant-proactivity-phone-en.png" });
});

test("a new agent switches check-ins on after saving", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/agents");
  await page.getByRole("button", { name: "New agent" }).click();
  const heartbeat = section(page).getByRole("checkbox", { name: "Check in on its own" });
  await expect(heartbeat).toBeDisabled();
  await expect(section(page)).toContainText("Available after saving the agent");
});

test("the proactivity section is translated", async ({ page }) => {
  await setup(page, {
    language: "de",
    assistant: { capabilities: { memory: true, reminders: false } },
  });
  await page.goto(baseURL + "/agents/home/settings");
  const proactivity = section(page);
  await expect(
    proactivity.getByRole("group", { name: "Von sich aus handeln" }),
  ).toBeVisible();
  await proactivity.getByRole("checkbox", { name: "Sich von selbst melden" }).check();
  await expect(proactivity).toContainText(
    "Etwa 3 zusätzliche Modellläufe pro Tag, jeweils mit der ganzen Unterhaltung.",
  );
  await expect(proactivity).toContainText("auf Telegram mit „Check-in:“ markiert");
});

test("a refused check-in keeps the form and shows why", async ({ page }) => {
  const message =
    "Check-ins need a paired Telegram chat. Connect a Telegram chat to this agent first.";
  const state = await setup(page, {
    saveStatus: 409,
    saveError: message,
    assistant: { capabilities: { memory: true, reminders: false } },
  });
  await page.goto(baseURL + "/agents/home/settings");
  const heartbeat = section(page).getByRole("checkbox", { name: "Check in on its own" });
  await heartbeat.check();
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect.poll(() => state.updates.length).toBe(1);
  await expect(page.getByText(message).first()).toBeVisible();
  await expect(heartbeat).toBeChecked();
});
