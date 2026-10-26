import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import {
  connectedChannel,
  setupAssistantSettings as setup,
} from "../helpers/assistant-settings-browser.js";
import { agentTab, saveBar, settingsPath } from "../helpers/agent-settings-page.js";

test.use({ timezoneId: "Europe/Berlin" });
const section = (page) => page.locator("#agent-proactivity");

test("check-ins are off, need memory, explain their cost and save", async ({ page }) => {
  const state = await setup(page, { channel: connectedChannel(), applyUpdates: true });
  await page.goto(baseURL + settingsPath("routines"));
  const proactivity = section(page);
  await expect(
    proactivity.getByRole("group", { name: "Acting on its own" }),
  ).toBeVisible();
  // Recall across conversations is not offered in this release.
  await expect(page.getByText("Remember across conversations")).toHaveCount(0);
  const heartbeat = proactivity.getByRole("switch", { name: "Check in on its own" });
  await expect(heartbeat).not.toBeChecked();
  await expect(heartbeat).toBeDisabled();
  await expect(proactivity).toContainText(
    "Needs memory: switch on “Remember information” under Capabilities.",
  );
  await agentTab(page, "Capabilities").click();
  await page.getByRole("switch", { name: "Remember information" }).check();
  await saveBar(page).getByRole("button", { name: "Save agent" }).click();
  await expect.poll(() => state.updates.length).toBe(1);
  expect(state.updates[0].capabilities.memory).toBe(true);
  expect(state.updates[0].capabilities).not.toHaveProperty("recall");
  await agentTab(page, "Automation").click();
  await expect(heartbeat).toBeEnabled();
  await expect(proactivity).toContainText("you get a push notification");
  await heartbeat.check();
  await expect(proactivity).toContainText(
    "Check-ins appear in the agent's chat, marked “Check-in”, so you can reply",
  );
  // The paired chat gets them too unless switched off.
  await expect(
    proactivity.getByRole("switch", { name: "Also send to Telegram" }),
  ).toBeChecked();
  await proactivity.getByLabel("How often").selectOption("2h");
  await proactivity.getByLabel("Active from").selectOption("8");
  await proactivity.getByLabel("Active until").selectOption("20");
  await expect(proactivity).toContainText(
    "Times in Europe/Berlin, within one day. About 6 extra model runs per day, each reading the recent conversation.",
  );
  await expect(proactivity.getByRole("button", { name: /Use my time zone/ })).toHaveCount(
    0,
  );
  await proactivity.getByLabel("How often").selectOption("daily");
  await expect(proactivity).toContainText("About 1 extra model run per day");
  await proactivity.getByLabel("How often").selectOption("1h");
  await expect(proactivity).toContainText("About 12 extra model runs per day");
  await proactivity.screenshot({ path: ".cache/assistant-proactivity-desktop-en.png" });
  await saveBar(page).getByRole("button", { name: "Save agent", exact: true }).click();
  await expect.poll(() => state.updates.length).toBe(2);
  expect(state.updates[1].heartbeat).toEqual({
    enabled: true,
    interval: "1h",
    start: 8,
    end: 20,
    timeZone: "Europe/Berlin",
    telegram: true,
  });
});

test("switching memory off also switches check-ins off", async ({ page }) => {
  const state = await setup(page, {
    channel: connectedChannel(),
    applyUpdates: true,
    assistant: {
      capabilities: { memory: true, reminders: false },
      heartbeat: { enabled: true, interval: "4h", start: 9, end: 18, timeZone: "UTC" },
    },
  });
  await page.goto(baseURL + settingsPath("capabilities"));
  await page.getByRole("switch", { name: /^Remember information/ }).uncheck();
  await saveBar(page).getByRole("button", { name: "Save agent" }).click();
  await expect.poll(() => state.updates.length).toBe(1);
  expect(state.updates[0].heartbeat.enabled).toBe(false);
  await agentTab(page, "Automation").click();
  await expect(
    section(page).getByRole("switch", { name: "Check in on its own" }),
  ).toBeDisabled();
});

test("an agent's saved check-ins load into the form and fit a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, {
    channel: connectedChannel(),
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
  await page.goto(baseURL + settingsPath("routines"));
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
  await setup(page, { channel: connectedChannel() });
  await page.goto(baseURL + "/agents");
  await page.getByRole("button", { name: "New agent" }).click();
  await agentTab(page, "Capabilities").click();
  const heartbeat = section(page).getByRole("switch", { name: "Check in on its own" });
  await expect(heartbeat).toBeDisabled();
  await expect(section(page)).toContainText("Available after saving the agent");
});

test("the proactivity section is translated", async ({ page }) => {
  await setup(page, {
    language: "de",
    channel: connectedChannel(),
    assistant: { capabilities: { memory: true, reminders: false } },
  });
  await page.goto(baseURL + settingsPath("routines"));
  const proactivity = section(page);
  await expect(
    proactivity.getByRole("group", { name: "Von sich aus handeln" }),
  ).toBeVisible();
  await proactivity.getByRole("switch", { name: "Sich von selbst melden" }).check();
  await expect(proactivity).toContainText(
    "Etwa 3 zusätzliche Modellläufe pro Tag, jeweils mit dem letzten Teil der Unterhaltung.",
  );
  await expect(proactivity).toContainText("mit „Check-in“ markiert");
  await expect(
    proactivity.getByRole("switch", { name: "Auch an Telegram senden" }),
  ).toBeChecked();
});

test("a refused check-in keeps the form and shows why", async ({ page }) => {
  const message =
    "Check-ins need memory. Switch on “Remember information” first, or switch check-ins off with it.";
  const state = await setup(page, {
    saveStatus: 409,
    saveError: message,
    assistant: { capabilities: { memory: true, reminders: false } },
  });
  await page.goto(baseURL + settingsPath("routines"));
  const heartbeat = section(page).getByRole("switch", { name: "Check in on its own" });
  await heartbeat.check();
  await saveBar(page).getByRole("button", { name: "Save agent", exact: true }).click();
  await expect.poll(() => state.updates.length).toBe(1);
  await expect(page.getByText(message).first()).toBeVisible();
  await expect(heartbeat).toBeChecked();
});

test("a refused check-in without memory shows the German reason", async ({ page }) => {
  const message =
    "Meldungen brauchen das Gedächtnis. Schalte zuerst „Informationen merken“ ein oder schalte die Meldungen mit ab.";
  const state = await setup(page, {
    language: "de",
    channel: connectedChannel(),
    saveStatus: 409,
    saveError: message,
    assistant: { capabilities: { memory: true, reminders: false } },
  });
  await page.goto(baseURL + settingsPath("routines"));
  const heartbeat = section(page).getByRole("switch", {
    name: "Sich von selbst melden",
  });
  await heartbeat.check();
  await saveBar(page, "Ungespeicherte Änderungen")
    .getByRole("button", { name: "Agent speichern", exact: true })
    .click();
  await expect.poll(() => state.updates.length).toBe(1);
  await expect(page.getByText(message).first()).toBeVisible();
  await expect(heartbeat).toBeChecked();
});
