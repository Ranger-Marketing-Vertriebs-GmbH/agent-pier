import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";
async function assistantFixture(
  page,
  {
    conversations = [{ id: "dinner", assistantId: "home" }],
    models = [{ id: "router", name: "OpenRouter", available: true }],
    opened = [],
  } = {},
) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const assistant = {
    id: "home",
    name: "Home assistant",
    instructions: "Plan meals",
    model: { connectionId: "router", modelId: "openai/gpt-4.1-mini" },
    revision: 2,
    effectiveRevision: 1,
  };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const url = new URL(route.request().url());
    let body = {};
    if (
      [
        "/api/assistant-channels",
        "/api/assistant-speech",
        "/api/assistant-runtime/updates",
      ].includes(url.pathname)
    )
      return route.fallback();
    if (url.pathname === "/api/assistants")
      body = {
        assistants: [assistant],
        conversations,
        models,
      };
    else if (url.pathname === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    else if (url.pathname === "/api/assistant-runtime")
      body = { availability: "ready", sync: "current", version: "2026.9.8" };
    else if (url.pathname.endsWith("/messages"))
      body = {
        messages: [
          { id: "reply", role: "assistant", text: "We can plan dinner together." },
        ],
        requests: [],
        stale: false,
      };
    else if (url.pathname.endsWith("/conversations")) {
      opened.push(url.pathname);
      body = { id: "dinner", assistantId: "home" };
    } else if (url.pathname === "/api/assistants/home") body = assistant;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
}
test("direct sidebar chat preserves drafts through settings and reload restores history", async ({
  page,
}) => {
  await assistantFixture(page);
  await page.goto(baseURL + "/agents");
  await page
    .locator("aside")
    .getByRole("button", { name: /^Home assistant, / })
    .click();
  await expect(page).toHaveURL(/\/agents\/home\/chats\/dinner$/);
  await expect(
    page.getByRole("log").getByText("We can plan dinner together."),
  ).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("Keep this dinner idea");
  await page.getByRole("button", { name: "Agent settings", exact: true }).click();
  await expect(page.getByText("Saved revision: 2 · Applied revision: 1")).toBeVisible();
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    "Keep this dinner idea",
  );
  await page.reload();
  await expect(
    page.getByRole("log").getByText("We can plan dinner together."),
  ).toBeVisible();
  await page.screenshot({ path: ".cache/assistant-chat-en.png", fullPage: true });
});
test("runtime settings expose service and synchronization separately on mobile", async ({
  page,
}) => {
  await assistantFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL + "/settings/assistants");
  await expect(page.getByRole("heading", { name: "Agent service" })).toBeVisible();
  await expect(
    page.locator(".assistant-runtime-card").first().getByText("Ready", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Up to date", { exact: true })).toBeVisible();
  await page.screenshot({
    path: ".cache/assistant-runtime-mobile-en.png",
    fullPage: true,
  });
});
test("German runtime distinguishes reconnection, synchronization and diagnostics", async ({
  page,
}) => {
  await assistantFixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "de"));
  await page.route("**/api/assistant-runtime", (route) =>
    route.fulfill({
      json: {
        availability: "reconnecting",
        sync: "stale",
        diagnostic: "CONNECTION_LOST",
      },
    }),
  );
  await page.goto(baseURL + "/settings/assistants");
  await expect(page.getByRole("heading", { name: "Agentendienst" })).toBeVisible();
  await expect(page.getByText("Verbindet erneut", { exact: true })).toBeVisible();
  await expect(page.getByText("Nicht synchronisiert", { exact: true })).toBeVisible();
  await page.getByText("Technische Details", { exact: true }).click();
  await expect(page.getByText("CONNECTION_LOST", { exact: true })).toBeVisible();
});
test("uncertain requests remain distinct from a ready runtime and keep drafts", async ({
  page,
}) => {
  await assistantFixture(page);
  await page.route("**/api/assistant-conversations/dinner/messages", (route) =>
    route.fulfill({
      json: {
        messages: [],
        requests: [
          {
            text: "Dinner",
            state: "uncertain",
            attempt: { id: "attempt", state: "uncertain" },
          },
        ],
        stale: true,
      },
    }),
  );
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(
    page.getByRole("log").getByText("Outcome unknown", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("Next idea");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(page.getByText(/Your draft is preserved/)).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Next idea");
  await expect(
    page.getByRole("button", { name: "Restart service and acknowledge uncertainty" }),
  ).toBeVisible();
});
test("late send acceptance preserves text edited after navigating back", async ({
  page,
}) => {
  await assistantFixture(page);
  let accept;
  let received = false;
  await page.route("**/api/assistant-conversations/dinner/messages", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    received = true;
    await new Promise((r) => {
      accept = r;
    });
    await route.fulfill({
      json: { request: { id: "sent" }, attempt: { id: "attempt", state: "accepted" } },
    });
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await page.getByLabel("Message", { exact: true }).fill("First request");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => received).toBe(true);
  await page.getByRole("button", { name: "Agent settings", exact: true }).click();
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  await page.getByLabel("Message", { exact: true }).fill("My next unsent idea");
  accept();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Agent settings", exact: true }).click();
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    "My next unsent idea",
  );
});
test("a sidebar assistant without a conversation opens its chat in one click", async ({
  page,
}) => {
  await assistantFixture(page);
  await page.route("**/api/assistants", (route) =>
    route.fulfill({
      json: {
        assistants: [
          {
            id: "home",
            name: "Home assistant",
            instructions: "Plan meals",
            model: { connectionId: "router", modelId: "fixture-model" },
            revision: 1,
            effectiveRevision: 1,
          },
        ],
        conversations: [],
        models: [{ id: "router", name: "OpenRouter", available: true }],
      },
    }),
  );
  await page.goto(baseURL + "/agents");
  await page
    .locator("aside")
    .getByRole("button", { name: /^Home assistant, / })
    .click();
  await expect(page).toHaveURL(/\/agents\/home\/chats\/dinner$/);
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
});
test("conversation and settings share the mockup navigation on desktop and mobile", async ({
  page,
}) => {
  await assistantFixture(page);
  await page.route("**/api/assistant-conversations/dinner/messages", (route) =>
    route.fulfill({
      json: {
        messages: [
          { id: "question", role: "user", text: "Help me plan three dinners." },
          { id: "answer", role: "assistant", text: "We can plan dinner together." },
        ],
        requests: [],
        stale: false,
      },
    }),
  );
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(baseURL + "/agents/home/chats/dinner");
    const nav = page.getByRole("navigation", { name: "Agent views" });
    await expect(
      nav.getByRole("button", { name: "Conversation", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await page.getByLabel("Message", { exact: true }).fill("Preserve my draft");
    const user = page.locator(".assistant-message.user"),
      assistant = page.locator(".assistant-message.assistant").first();
    const userBox = await user.boundingBox(),
      assistantBox = await assistant.boundingBox();
    expect(userBox.x).toBeGreaterThan(assistantBox.x);
    await nav.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/agents\/home\/settings$/);
    await expect(
      nav.getByRole("button", { name: "Settings", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("heading", { name: "Agent service", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `.cache/assistant-settings-aligned-${width}-en.png`,
      fullPage: true,
    });
    await nav.getByRole("button", { name: "Conversation", exact: true }).click();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
      "Preserve my draft",
    );
    const sendBox = await page
      .getByRole("button", { name: "Send", exact: true })
      .boundingBox();
    expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(1000);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `.cache/assistant-chat-aligned-${width}-en.png`,
      fullPage: true,
    });
  }
});

for (const source of ["sidebar", "settings"]) {
  test(`late ${source} chat opening preserves newer navigation`, async ({ page }) => {
    await assistantFixture(page, { conversations: [] });
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    await page.route("**/api/assistants/home/conversations", async (route) => {
      await pending;
      await route.fulfill({ json: { id: "dinner", assistantId: "home" } });
    });
    await page.goto(
      baseURL + (source === "sidebar" ? "/settings/assistants" : "/agents/home/settings"),
    );
    const requested = page.waitForRequest("**/api/assistants/home/conversations");
    if (source === "sidebar") {
      await page
        .locator("aside")
        .getByRole("button", { name: /^Home assistant, / })
        .click();
      await requested;
      await page.getByRole("button", { name: "General", exact: true }).click();
    } else {
      await page
        .getByRole("navigation", { name: "Agent views" })
        .getByRole("button", { name: "Conversation", exact: true })
        .click();
      await requested;
      await page
        .locator(".assistant-breadcrumb")
        .getByRole("button", { name: "Agents", exact: true })
        .click();
    }
    const expected = source === "sidebar" ? /\/settings(?:\/general)?$/ : /\/agents$/;
    await expect(page).toHaveURL(expected);
    const refreshed = page.waitForResponse("**/api/assistant-runtime");
    release();
    await refreshed;
    // Allow the fulfilled open/refresh promises and resulting navigation to commit.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(page).toHaveURL(expected);
  });
}
test("an agent whose connection was deleted shows the missing connection instead of Ready", async ({
  page,
}) => {
  const opened = [];
  await assistantFixture(page, {
    conversations: [],
    models: [{ id: "other", name: "Other", available: true }],
    opened,
  });
  await page.goto(baseURL + "/agents");
  const card = page.locator(".assistant-card").filter({ hasText: "Home assistant" });
  await expect(
    card.getByText("Provider connection missing", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("aside").getByRole("button", { name: /^Home assistant, / }),
  ).toHaveAccessibleName(/Provider connection missing/);
  await card.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect(
    page.getByText(
      "This agent's provider connection was deleted. Choose another provider connection in the agent settings.",
    ),
  ).toBeVisible();
  expect(opened).toEqual([]);
  await page.goto(baseURL + "/agents/home/settings");
  await expect(page.locator(".assistant-state-badge")).toHaveText(
    "Provider connection missing",
  );
});
