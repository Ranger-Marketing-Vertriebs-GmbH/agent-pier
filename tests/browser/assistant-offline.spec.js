import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture, emit } from "../helpers/assistant-chat-fixture.js";

const hint =
  "Connection interrupted. Your draft is preserved; history will refresh when connected.";
const sidebarNote = "Connection lost. Showing the last known agents.";
const lead = chatAssistant({ id: "lead", name: "Chief of Staff" });
const scout = chatAssistant({
  id: "scout",
  name: "Scout",
  teamMemberId: "m1",
  parentAssistantId: "lead",
  lifetime: "task",
  teamId: "t1",
});
const histories = {
  dinner: [
    { id: "question", role: "user", text: "Help me plan three dinners." },
    { id: "answer", role: "assistant", text: "We can plan dinner together." },
  ],
  relaunch: [{ id: "brief", role: "assistant", text: "The relaunch plan is ready." }],
};

// One agent with a chat and a lead with a running team member; `network.offline`
// fails every API request the way a lost connection does.
async function offlineFixture(page) {
  const state = await chatFixture(page, {
    assistants: [chatAssistant(), lead, scout],
    conversations: [
      { id: "dinner", assistantId: "home" },
      { id: "relaunch", assistantId: "lead" },
    ],
    teams: [
      {
        id: "t1",
        parentAssistantId: "lead",
        objective: "Prepare the relaunch",
        phase: "running",
        members: [],
        memberIds: ["m1"],
      },
    ],
    members: [
      {
        id: "m1",
        teamId: "t1",
        assistantId: "scout",
        name: "Scout",
        role: "Research",
        assignment: "Review competitor pages",
        phase: "running",
        lifetime: "task",
      },
    ],
  });
  await page.route(/\/api\/assistant-conversations\/[^/]+\/messages$/, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const id = new URL(route.request().url()).pathname.split("/")[3];
    return route.fulfill({
      json: { messages: histories[id] || [], requests: [], stale: false },
    });
  });
  const network = { offline: false, authenticated: true };
  await page.route("**/auth/status", (route) =>
    route.fulfill({
      json: { configured: true, authenticated: network.authenticated, canSetup: false },
    }),
  );
  await page.route("**/api/**", (route) =>
    network.offline ? route.abort("internetdisconnected") : route.fallback(),
  );
  return { state, network };
}

const sidebar = (page) => page.locator(".sidebar");
const row = (page, name) =>
  sidebar(page).getByRole("button", { name: new RegExp(`^${name}, `) });

async function loseConnection(page, network) {
  network.offline = true;
  await page.evaluate(() => {
    window.dispatchEvent(new Event("offline"));
    window.assistantTestStream.onerror?.();
  });
}

test("agents, team members and cached chats stay visible while offline and refresh on reconnect", async ({
  page,
}) => {
  const { state, network } = await offlineFixture(page);
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.getByText("We can plan dinner together.")).toBeVisible();
  await row(page, "Chief of Staff").click();
  await expect(page.getByText("The relaunch plan is ready.")).toBeVisible();

  await loseConnection(page, network);
  await expect(sidebar(page).getByText(sidebarNote)).toBeVisible();
  await expect(page.getByText(hint)).toBeVisible();
  // Agents, their team members and the hierarchy stay in the sidebar.
  await sidebar(page)
    .getByRole("button", { name: /Show team members \(1\)/ })
    .click();
  const team = sidebar(page).getByRole("group", { name: "Prepare the relaunch" });
  await expect(team.getByRole("button", { name: /^Scout, / })).toBeVisible();
  // Another chat opens from what was last read, read-only.
  await row(page, "Home assistant").click();
  await expect(page).toHaveURL(/\/agents\/home\/chats\/dinner$/);
  await expect(page.getByText("We can plan dinner together.")).toBeVisible();
  await expect(page.getByText(hint)).toBeVisible();
  await expect(page.getByText("Failed to fetch")).toHaveCount(0);
  const field = page.getByLabel("Message", { exact: true });
  await field.fill("Add a vegetarian option");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  // What Enter does on a keyboard; touch keyboards insert a line break instead.
  await field.evaluate((element) => element.form.requestSubmit());
  expect(state.posted).toEqual([]);
  await expect(field).toHaveValue("Add a vegetarian option");

  // Back online: the list and the open chat refresh by themselves.
  state.assistants = [chatAssistant({ name: "Home planner" }), lead, scout];
  histories.dinner = [
    ...histories.dinner,
    { id: "late", role: "assistant", text: "Here is a vegetarian lasagne." },
  ];
  network.offline = false;
  await page.evaluate(() => window.assistantTestStream.onopen?.());
  await emit(page, { type: "connected" });
  await expect(row(page, "Home planner")).toBeVisible();
  await expect(page.getByText("Here is a vegetarian lasagne.")).toBeVisible();
  await expect(sidebar(page).getByText(sidebarNote)).toHaveCount(0);
  await expect(page.getByText(hint)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await expect(field).toHaveValue("Add a vegetarian option");
});

test("a failed list read keeps the agents and the next successful read restores the state", async ({
  page,
}) => {
  const { network } = await offlineFixture(page);
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.getByText("We can plan dinner together.")).toBeVisible();
  network.offline = true;
  // The page comes back to the foreground while the server is unreachable.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(sidebar(page).getByText(sidebarNote)).toBeVisible();
  await expect(row(page, "Home assistant")).toBeVisible();
  await expect(row(page, "Chief of Staff")).toBeVisible();
  await expect(page.getByText(hint)).toBeVisible();
  histories.dinner = [
    ...histories.dinner,
    { id: "while-away", role: "assistant", text: "Shopping list is ready." },
  ];
  // Back without an event stream: the next read alone brings list and chat back.
  network.offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(sidebar(page).getByText(sidebarNote)).toHaveCount(0);
  await expect(page.getByRole("log").getByText("Shopping list is ready.")).toBeVisible();
  await expect(page.getByText(hint)).toHaveCount(0);
});

test("a refused event stream is opened again and refreshes the agents", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const names = ["Home assistant"];
  let streams = 0;
  await page.route(/\/api\/assistant/, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/assistant-feature")
      return route.fulfill({ json: { enabled: true, error: null } });
    if (path === "/api/assistant-events")
      // The first stream meets AgentPier restarting; the browser never retries it.
      return ++streams === 1
        ? route.fulfill({ status: 503, json: { code: "ASSISTANTS_UNAVAILABLE" } })
        : route.fulfill({
            contentType: "text/event-stream",
            body: 'data: {"type":"connected"}\n\n',
          });
    if (path === "/api/assistant-runtime")
      return route.fulfill({ json: { availability: "ready", sync: "current" } });
    if (path === "/api/assistants")
      return route.fulfill({
        json: {
          assistants: [chatAssistant({ name: names.at(-1) })],
          conversations: [],
          models: [{ id: "router", name: "OpenRouter", available: true }],
        },
      });
    return route.fallback();
  });
  await page.goto(baseURL);
  await expect(row(page, "Home assistant")).toBeVisible();
  names.push("Home planner");
  await expect(row(page, "Home planner")).toBeVisible({ timeout: 10000 });
  expect(streams).toBeGreaterThan(1);
});

test("a logout forgets the agent drafts", async ({ page }) => {
  const { network } = await offlineFixture(page);
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.getByText("We can plan dinner together.")).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("Private draft");
  network.authenticated = false;
  await page.evaluate(() => window.dispatchEvent(new Event("agentpier-login-required")));
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  network.authenticated = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("We can plan dinner together.")).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
});
