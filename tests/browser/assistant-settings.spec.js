import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import {
  emitChange as change,
  home,
  setupAssistantSettings as setup,
} from "../helpers/assistant-settings-browser.js";
const visibility = (page, value) =>
  page.evaluate((state) => {
    Object.defineProperty(document, "visibilityState", {
      value: state,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, value);

test("settings edits survive a revision bump and a conflicting change offers a reload", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto(baseURL + "/agents/home/settings");
  const name = page.getByLabel("Name", { exact: true });
  await name.fill("Home edited");
  state.assistants = [home({ revision: 2, instructions: "Server instructions" })];
  await change(page);
  await expect(page.getByRole("textbox", { name: "Instructions" })).toHaveValue(
    "Server instructions",
  );
  await expect(name).toHaveValue("Home edited");
  await expect(
    page.getByRole("status").filter({ hasText: "changed on the server" }),
  ).toHaveCount(0);
  state.assistants = [home({ revision: 3, name: "Server name" })];
  await change(page);
  const banner = page.getByRole("status").filter({ hasText: "changed on the server" });
  await expect(banner).toBeVisible();
  await expect(name).toHaveValue("Home edited");
  await banner.getByRole("button", { name: "Reload latest" }).click();
  await expect(name).toHaveValue("Server name");
  await expect(banner).toHaveCount(0);
});

test("hidden tabs stop polling and resume when visible again", async ({ page }) => {
  const state = await setup(page);
  await page.goto(baseURL + "/agents/home/settings");
  await expect.poll(() => state.counts.channels).toBeGreaterThan(1);
  await visibility(page, "hidden");
  await page.waitForTimeout(500);
  const quiet = state.counts.channels;
  await page.waitForTimeout(5000);
  expect(state.counts.channels).toBe(quiet);
  await visibility(page, "visible");
  await expect.poll(() => state.counts.channels).toBeGreaterThan(quiet);
});

test("slow polls never overlap", async ({ page }) => {
  const state = await setup(page, { actionDelay: 4500 });
  await page.goto(baseURL + "/agents/home/settings");
  await page.waitForTimeout(10500);
  expect(state.inflight.maxActions).toBe(1);
});

test("links to Accounts and Settings navigate inside the app", async ({ page }) => {
  await setup(page, { runtime: { availability: "failed", sync: "stale" } });
  await page.goto(baseURL + "/agents/home/settings");
  await page.evaluate(() => (window.__marker = "same-document"));
  await page.getByRole("link", { name: "Manage Deepgram in Accounts" }).click();
  await expect(page).toHaveURL(/\/accounts$/);
  expect(await page.evaluate(() => window.__marker)).toBe("same-document");
  await page.getByRole("link", { name: "Agent service settings" }).click();
  await expect(page).toHaveURL(/\/settings\/assistants$/);
  expect(await page.evaluate(() => window.__marker)).toBe("same-document");
});

for (const [language, locale] of [
  ["en", "en-US"],
  ["de", "de-DE"],
]) {
  test(`dates follow the interface language (${language})`, async ({ page }) => {
    const at = Date.UTC(2026, 9, 20, 13, 5);
    await setup(page, {
      language,
      assistant: { capabilities: { memory: false, reminders: true } },
      reminders: [
        {
          id: "r1",
          name: "Water",
          status: "ready",
          enabled: true,
          revision: 1,
          schedule: { kind: "at" },
          nextRunAtMs: at,
        },
      ],
      routines: [
        {
          id: "t1",
          name: "Digest",
          prompt: "Summarize",
          status: "ready",
          enabled: true,
          revision: 1,
          trigger: { kind: "at", at: new Date(at).toISOString() },
          nextRunAtMs: at,
        },
      ],
    });
    await page.goto(baseURL + "/agents/home/settings");
    const expected = new Date(at).toLocaleString(locale);
    await expect(page.getByText(expected, { exact: false }).first()).toBeVisible();
    expect(await page.getByText(expected, { exact: false }).count()).toBeGreaterThan(2);
  });
}

test("sidebar items are named with agent and status", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/agents/home/settings");
  await expect(page.getByRole("button", { name: /^Home, .*Ready$/ })).toBeVisible();
});

test("agents without a usable name show a fallback avatar", async ({ page }) => {
  await setup(page, {
    assistants: [home({ id: "blank", name: "  " }), home({ name: "😀 Pip" })],
  });
  await page.goto(baseURL + "/agents");
  const avatars = page.locator(".assistant-card .assistant-avatar");
  await expect(avatars).toHaveCount(2);
  await expect(avatars.nth(0)).toHaveText(/\S/);
  await expect(avatars.nth(1)).toHaveText("😀");
});

test("review-lane Telegram entries offer the review action", async ({ page }) => {
  const state = await setup(page, {
    channel: {
      id: "telegram",
      assistantId: "home",
      conversationId: "chat",
      username: "bot",
      enabled: true,
      hasSecret: true,
      chatId: "42",
      revision: 1,
      inputs: [
        { id: "a", state: "reply_unavailable", text: "One" },
        { id: "b", state: "model_reviewed", text: "Two" },
        { id: "c", state: "running", text: "Three" },
      ],
    },
  });
  await page.goto(baseURL + "/agents/home/settings");
  const panel = page.getByRole("region", { name: "Telegram" });
  await expect(panel.getByText("Answer without text")).toBeVisible();
  await expect(panel.getByText("Outcome reviewed in chat")).toBeVisible();
  const reviews = panel.getByRole("button", { name: "Acknowledge without resending" });
  await expect(reviews).toHaveCount(2);
  await expect(panel.getByText(/Still in progress/)).toHaveCount(1);
  await reviews.first().click();
  await expect.poll(() => state.reviews.length).toBe(1);
});

test("runtime and conversation faults are explained", async ({ page }) => {
  const state = await setup(page, {
    runtime: { availability: "failed", sync: "stale", diagnostic: "RESTART_LIMIT" },
    conversations: [
      { id: "chat", assistantId: "home", diagnostic: "SESSION_UNAVAILABLE" },
    ],
  });
  await page.goto(baseURL + "/settings/assistants");
  await expect(page.getByText(/stopped restarting automatically/i)).toBeVisible();
  state.runtime = {
    availability: "ready",
    sync: "current",
    diagnostic: "WRITE_GUARD_PENDING",
  };
  await page.goto(baseURL + "/settings/assistants");
  await expect(page.getByText(/memory writes wait/i)).toBeVisible();
  await page.goto(baseURL + "/agents/home/chats/chat");
  await expect(page.getByText(/session is not available/i)).toBeVisible();
});

test("mobile settings have section links and inline permission checkboxes", async ({
  page,
}) => {
  await setup(page, {
    assistant: { capabilities: { memory: true, reminders: true } },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL + "/agents/home/settings");
  await page.evaluate(() => (window.__marker = "same-document"));
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await expect(nav).toBeVisible();
  for (const name of ["Telegram", "Memory", "Reminders"])
    await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
  await nav.getByRole("link", { name: "Telegram", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Telegram", exact: true }),
  ).toBeInViewport();
  expect(await page.evaluate(() => window.__marker)).toBe("same-document");
  // Measured in one synchronous step so a running scroll cannot skew the comparison.
  const { box, text } = await page
    .locator(".assistant-team-permission")
    .first()
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el.lastChild);
      const t = range.getBoundingClientRect();
      const b = el.querySelector("input").getBoundingClientRect();
      return {
        box: { x: b.x, y: b.y, width: b.width, height: b.height },
        text: { top: t.top, height: t.height, left: t.left },
      };
    });
  expect(box.height).toBeLessThanOrEqual(24);
  expect(box.x + box.width).toBeLessThanOrEqual(text.left);
  expect(
    Math.abs(box.y + box.height / 2 - (text.top + text.height / 2)),
  ).toBeLessThanOrEqual(8);
});

test("settings header names the view instead of a status badge", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/agents/home/settings");
  await expect(page.locator(".assistant-header-sub")).toHaveText("Settings");
  await expect(page.locator(".assistant-header-status")).toHaveCount(0);
});

test("section links move focus to the section heading", async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL + "/agents/home/settings");
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "Telegram", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Telegram", exact: true }),
  ).toBeFocused();
});

test("the model field lists the connection's models and keeps a custom model ID", async ({
  page,
}) => {
  const state = await setup(page, {
    assistant: { model: { connectionId: "local", modelId: "qwen3:4b" } },
    models: [
      { id: "router", name: "Router", available: true },
      {
        id: "local",
        name: "Ollama",
        providerId: "endpoint",
        available: true,
        models: [
          { modelId: "qwen3:4b", label: "Qwen 3 4B" },
          { modelId: "llama3.2", label: "llama3.2" },
        ],
      },
    ],
  });
  await page.goto(baseURL + "/agents/home/settings");
  const model = page.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toHaveValue("qwen3:4b");
  await expect(model.locator("option")).toHaveText([
    "Choose a model",
    "Qwen 3 4B (qwen3:4b)",
    "llama3.2",
    "Custom model ID…",
  ]);
  await expect(page.getByRole("textbox", { name: "Model ID" })).toHaveCount(0);
  await model.selectOption("llama3.2");
  await model.selectOption({ label: "Custom model ID…" });
  await page.getByRole("textbox", { name: "Model ID" }).fill("qwen3:8b");
  await page.getByRole("button", { name: "Save agent" }).click();
  await expect
    .poll(() => state.updates.at(-1)?.model)
    .toEqual({ connectionId: "local", modelId: "qwen3:8b" });
  await page.getByLabel("Model connection").selectOption("router");
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Model ID" })).toHaveValue("qwen3:8b");
  // Back on the catalog connection the typed ID is not replaced by a listed model.
  await page.getByLabel("Model connection").selectOption("local");
  await expect(model).toHaveValue("");
  await expect(model.locator("option:checked")).toHaveText("Choose a model");
  await expect(page.getByRole("textbox", { name: "Model ID" })).toHaveCount(0);
  await model.selectOption({ label: "Custom model ID…" });
  await expect(page.getByRole("textbox", { name: "Model ID" })).toHaveValue("qwen3:8b");
});
