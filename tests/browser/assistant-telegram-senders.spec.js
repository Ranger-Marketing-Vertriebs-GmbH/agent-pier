import path from "node:path";
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { home, setupAssistantSettings } from "../helpers/assistant-settings-browser.js";

// Screenshots for a review go to this directory when it is set; never into docs/.
const shots = process.env.AGENTPIER_TELEGRAM_SENDERS_SHOTS;
const affected = { agents: [{ id: "home", name: "Home" }], teamMembers: 0 };

// A stand-in for server/http/routes/assistant-telegram-senders.js: a change asks to
// restart the agent service once; the confirmed request repeats it.
async function senders(page, options = {}) {
  const state = {
    view: {
      assistantId: "home",
      bot: options.bot || null,
      status: options.bot ? { state: options.state || "running" } : null,
      voice: options.voice ?? true,
      shell: options.shell || "off",
    },
    requests: [],
  };
  await page.route(/\/api\/assistant-telegram-senders\//, async (route) => {
    const request = route.request();
    const method = request.method();
    if (method === "GET") return route.fulfill({ json: state.view });
    const body = request.postDataJSON() || {};
    state.requests.push({ method, path: new URL(request.url()).pathname, body });
    if (!body.confirmRestart && options.restart !== false)
      return route.fulfill({
        status: 409,
        json: {
          code: "ASSISTANT_RESTART_REQUIRED",
          error:
            "This Telegram change restarts the agents' Gateway; confirm the restart.",
          affected,
        },
      });
    if (method === "DELETE") state.view = { ...state.view, bot: null, status: null };
    else if (method === "PUT") {
      const bot = state.view.bot || { username: "helper_fixture_bot", botId: "7001" };
      state.view = {
        ...state.view,
        bot: {
          ...bot,
          people: body.people ?? bot.people,
          revision: (bot.revision || 0) + 1,
        },
        status: { state: "running" },
      };
    }
    return route.fulfill({ json: state.view });
  });
  return state;
}

test("connects an agent's own bot for chosen people after confirming the restart", async ({
  page,
}) => {
  await setupAssistantSettings(page);
  const state = await senders(page);
  await page.goto(baseURL + "/agents/home/settings");
  const section = page.getByRole("region", { name: "Telegram for other people" });
  await expect(section).toBeVisible();
  await expect(section.getByText("Nobody can write to the bot yet.")).toBeVisible();
  // A username is no Telegram user id.
  await section.getByLabel("Name").fill("Alice");
  await section.getByLabel("Telegram user ID").fill("@alice");
  await section.getByRole("button", { name: "Add person" }).click();
  await expect(section.getByText("Enter a numeric Telegram user ID.")).toBeVisible();
  await section.getByLabel("Telegram user ID").fill("111");
  await section.getByRole("button", { name: "Add person" }).click();
  await section.getByLabel("Name").fill("Bob");
  await section.getByLabel("Telegram user ID").fill("222");
  await section.getByRole("button", { name: "Add person" }).click();
  await expect(section.getByRole("button", { name: "Remove Bob" })).toBeVisible();
  await section
    .getByLabel("Bot token")
    .fill("7001:fixture-token-abcdefghijklmnopqrstuvwxyz");
  await section.getByRole("button", { name: "Connect bot" }).click();
  const dialog = section.getByRole("alertdialog", { name: "Restart the agent service?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Home");
  await dialog.getByRole("button", { name: "Save and restart" }).click();
  await expect(section.getByText("Bot @helper_fixture_bot")).toBeVisible();
  await expect(section.getByText("Status: running")).toBeVisible();
  expect(state.requests.map((r) => [r.method, r.body.confirmRestart ?? false])).toEqual([
    ["PUT", false],
    ["PUT", true],
  ]);
  expect(state.requests[1].body).toMatchObject({
    token: "7001:fixture-token-abcdefghijklmnopqrstuvwxyz",
    people: [
      { id: "111", name: "Alice" },
      { id: "222", name: "Bob" },
    ],
    revision: null,
  });
  // The token field is cleared and never shown again.
  await expect(section.getByLabel("New bot token")).toHaveValue("");
  await expect(page.getByText("fixture-token")).toHaveCount(0);
  if (shots) {
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({ path: path.join(shots, "telegram-senders-desktop.png") });
  }
});

test("removes a person and disconnects the bot", async ({ page }) => {
  await setupAssistantSettings(page);
  const bot = {
    username: "helper_fixture_bot",
    botId: "7001",
    revision: 3,
    people: [
      { id: "111", name: "Alice" },
      { id: "222", name: "Bob" },
    ],
  };
  const state = await senders(page, { bot, restart: false, voice: false });
  await page.goto(baseURL + "/agents/home/settings");
  const section = page.getByRole("region", { name: "Telegram for other people" });
  await expect(section.getByText("Voice messages are not transcribed.")).toBeVisible();
  await section.getByRole("button", { name: "Remove Alice" }).click();
  await expect(section.getByRole("button", { name: "Remove Alice" })).toHaveCount(0);
  expect(state.requests[0].body).toEqual({
    people: [{ id: "222", name: "Bob" }],
    revision: 3,
  });
  await section.getByRole("button", { name: "Disconnect bot" }).click();
  await expect(section.getByLabel("Bot token")).toBeVisible();
  expect(state.requests[1]).toMatchObject({ method: "DELETE", body: { revision: 4 } });
});

test("a pending change can be applied, and shell blocks a new bot", async ({ page }) => {
  await setupAssistantSettings(page);
  const bot = { username: "helper_fixture_bot", revision: 1, people: [] };
  const state = await senders(page, { bot, state: "pending" });
  await page.goto(baseURL + "/agents/home/settings");
  const section = page.getByRole("region", { name: "Telegram for other people" });
  await expect(section.getByText("Status: waiting for a restart")).toBeVisible();
  await section.getByRole("button", { name: "Apply now" }).click();
  await section.getByRole("button", { name: "Save and restart" }).click();
  expect(state.requests.map((r) => [r.path, r.body.confirmRestart ?? false])).toEqual([
    ["/api/assistant-telegram-senders/apply", false],
    ["/api/assistant-telegram-senders/apply", true],
  ]);

  const other = await page.context().newPage();
  await setupAssistantSettings(other, { assistant: { shell: "approval" } });
  await senders(other, { shell: "approval" });
  await other.goto(baseURL + "/agents/home/settings");
  const blocked = other.getByRole("region", { name: "Telegram for other people" });
  await expect(blocked.getByText("Turn shell off before you connect")).toBeVisible();
  await expect(blocked.getByLabel("Bot token")).toHaveCount(0);
});

test("fits a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setupAssistantSettings(page, { assistants: [home()] });
  await senders(page, {
    bot: {
      username: "helper_fixture_bot",
      revision: 2,
      people: [
        { id: "111", name: "Alice" },
        { id: "222222222", name: "Bob with a rather long display name" },
      ],
    },
  });
  await page.goto(baseURL + "/agents/home/settings");
  const section = page.getByRole("region", { name: "Telegram for other people" });
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByText("Status: running")).toBeVisible();
  // The jump link of the section's chip row on narrow screens.
  await expect(page.getByRole("link", { name: "Telegram for others" })).toHaveCount(1);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  if (shots)
    await section.screenshot({ path: path.join(shots, "telegram-senders-phone.png") });
});
