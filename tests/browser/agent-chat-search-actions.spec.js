// The agent chat's own ⌘K actions (agent-chat-entries.js): New chat and Summarize now
// are offered only while an agent chat is on screen, and in a split view only the
// focused pane takes them.
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture } from "../helpers/assistant-chat-fixture.js";
import { leaf, split, splitViewFixture, viewId } from "../helpers/split-views-browser.js";

test.use({ viewport: { width: 1440, height: 1000 } });

const dialog = (page) => page.getByRole("dialog", { name: "Search" });
const option = (page, name) => dialog(page).getByRole("option", { name, exact: true });
// The page actions, as the palette names them: the action and its page.
const newChat = "New chat Agents";
const summarise = "Summarize this chat Agents";
const messages = Array.from({ length: 6 }, (_, n) => ({
  id: `m${n}`,
  role: n % 2 ? "assistant" : "user",
  text: `Message ${n + 1}`,
}));

async function search(page, text) {
  await page.keyboard.press("Control+k");
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole("combobox").fill(text);
}

// The search's own reads, empty.
async function quiet(page) {
  const empty = {
    "/api/repositories": { repositories: [] },
    "/api/memory/projects": { projects: [] },
    "/api/pipelines": { pipelines: [] },
    "/api/pipeline-runs": { runs: [], total: 0, page: 1, pageSize: 20 },
    "/api/inbox": { instance: "fixture", revision: 1, items: [], counts: { all: 0 } },
  };
  await page.route(
    (url) => Object.hasOwn(empty, url.pathname),
    (route) => route.fulfill({ json: empty[new URL(route.request().url()).pathname] }),
  );
}

// The search reads Ctrl+K on Linux (search-shortcut.js).
async function linux(page) {
  await page.addInitScript(() => {
    const data = { platform: "Linux", brands: [], mobile: false };
    Object.defineProperty(Navigator.prototype, "platform", {
      get: () => "Linux x86_64",
      configurable: true,
    });
    Object.defineProperty(Navigator.prototype, "userAgentData", {
      get: () => data,
      configurable: true,
    });
  });
}

test("New chat and Summarize now are offered only in an agent chat", async ({ page }) => {
  await linux(page);
  await chatFixture(page, {
    conversations: [{ id: "dinner", assistantId: "home", title: "Dinner plans" }],
    history: { messages, requests: [], stale: false },
  });
  await page.route("**/api/assistants/home/pinboard", (route) =>
    route.fulfill({ json: { fresh: 0, lists: [] } }),
  );
  await quiet(page);
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.locator(".assistant-header")).toBeVisible();
  await search(page, "New chat");
  await expect(option(page, newChat)).toBeVisible();
  await dialog(page).getByRole("combobox").fill("Summarize");
  await expect(option(page, summarise)).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto(baseURL + "/settings");
  // The reload first shows the login check; the shortcut listens once the app is up.
  await expect(page.locator(".sidebar")).toBeVisible();
  await search(page, "New chat");
  await expect(dialog(page)).toContainText("Nothing found");
  await expect(option(page, newChat)).toHaveCount(0);
  await dialog(page).getByRole("combobox").fill("Summarize");
  await expect(dialog(page)).toContainText("Nothing found");
  await expect(option(page, summarise)).toHaveCount(0);
});

test("in a split view New chat runs in the focused pane only", async ({ page }) => {
  await linux(page);
  const second = {
    type: "pane",
    item: { kind: "chat", assistantId: "a2", conversationId: "c2" },
  };
  const controls = await splitViewFixture(page, {
    layout: split("row", leaf.c1(), second),
    chat: {
      assistants: [
        chatAssistant({ id: "a1" }),
        chatAssistant({ id: "a2", name: "Studio lead" }),
      ],
      conversations: [
        { id: "c1", assistantId: "a1" },
        { id: "c2", assistantId: "a2" },
      ],
    },
  });
  await page.route(/\/api\/assistants\/a[12]\/pinboard$/, (route) =>
    route.fulfill({ json: { fresh: 0, lists: [] } }),
  );
  await quiet(page);
  await page.goto(`${baseURL}/views/${viewId}`);
  const pane = page.locator('.split-pane[data-pane-key="chat:a2:c2"]');
  await expect(pane.locator(".assistant-header h2")).toHaveText("Studio lead");
  await pane.locator(".assistant-header h2").click();
  await expect(page.locator(".split-pane-focused")).toHaveCount(1);
  await expect(pane.locator(".split-pane-focused")).toHaveCount(1);
  await search(page, "New chat");
  await option(page, newChat).click();
  const created = () =>
    controls.agents.calls.filter((path) => /\/api\/assistants\/a[12]\/chats$/.test(path));
  await expect.poll(created).toEqual(["/api/assistants/a2/chats"]);
});
