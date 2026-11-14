import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { openNewSession } from "../helpers/navigation.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";
import {
  architect,
  planner,
  project,
  talkFixture,
} from "./session-agent-talk-fixture.js";

// Sessions and agents talking to each other in English (docs/session-agent-talk.md):
// a session's Agent access dialog, the new-session dialog's agent choice, the
// "Sessions may talk" switch of an agent's projects, the session's turns and sends
// in the agent's chat, and ⌘K's "Agent access" action.
const dialog = (page) => page.getByRole("dialog");
const openAccess = (page) =>
  page.getByRole("button", { name: "Agent access", exact: true }).first().click();

test("the Agent access dialog saves a tick and shows the project's agent as fixed", async ({
  page,
  liveStub,
}) => {
  const state = await talkFixture(page);
  await page.goto(baseURL + "/sessions/deploy/chat");
  await openAccess(page);
  await liveStub.waitForSubscribe("session.agent-access:deploy");
  const access = dialog(page);
  await expect(access.getByRole("heading", { name: "Agent access" })).toBeVisible();
  await expect(access.getByText("Can ask agents", { exact: true })).toBeVisible();
  const inherited = access.getByRole("checkbox", { name: /Network Architect/ });
  await expect(inherited).toBeChecked();
  await expect(inherited).toBeDisabled();
  await expect(access.getByText("via project", { exact: true })).toBeVisible();
  const own = access.getByRole("checkbox", { name: /Planner/ });
  await expect(own).not.toBeChecked();
  await own.check();
  await access.getByRole("button", { name: "Save", exact: true }).click();
  await expect(access.getByText("Saved.", { exact: true })).toBeVisible();
  expect(state.accessPuts).toEqual([
    { id: "deploy", body: { assistantIds: [planner.id] } },
  ]);
  await expect(own).toBeChecked();
});

test("a session without AgentPier tools says it cannot ask", async ({ page }) => {
  await talkFixture(page);
  await page.goto(baseURL + "/sessions/bare/chat");
  await openAccess(page);
  const access = dialog(page);
  await expect(
    access.getByText(/Runs without AgentPier tools: agents can write to it/),
  ).toBeVisible();
  await expect(access.getByText("via project")).toHaveCount(0);
  await expect(access.getByRole("checkbox", { name: /Network Architect/ })).toBeEnabled();
});

test("the new-session dialog sends the ticked agents as agentAccessIds", async ({
  page,
}) => {
  const state = await talkFixture(page);
  await page.goto(baseURL);
  await openNewSession(page);
  await dialog(page)
    .getByLabel("Working directory", { exact: true })
    .fill("/work/homelab");
  await dialog(page).locator(".launch-extensions > summary").click();
  const agents = dialog(page).getByRole("group", { name: "Agents" });
  await expect(agents.getByRole("checkbox", { name: /Network Architect/ })).toBeVisible();
  await agents.getByRole("checkbox", { name: /Network Architect/ }).check();
  await expect(dialog(page).getByText(/1 agent\b/)).toBeVisible();
  await dialog(page).getByRole("button", { name: "Start session", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Launch rejected");
  expect(state.launches.at(-1).agentAccessIds).toEqual([architect.id]);
});

test("the agent's Projects row switches Sessions may talk and saves talkProjectIds", async ({
  page,
}) => {
  const state = await talkFixture(page);
  await page.goto(baseURL + settingsPath("access", null, architect.id));
  const talk = page.getByRole("switch", { name: `Sessions of ${project.name} may talk` });
  await expect(talk).not.toBeChecked();
  await expect(page.getByText("Sessions may talk", { exact: true })).toBeVisible();
  await talk.check();
  await saveBar(page).getByRole("button", { name: "Save agent", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.saves[0].talkProjectIds).toEqual([project.id]);
});

test("the agent chat shows a session's ask and the agent's send to it", async ({
  page,
}) => {
  await talkFixture(page);
  await page.goto(baseURL + "/agents/architect/chats/dinner");
  const asked = page.locator(".assistant-message.user", { hasText: "give me a free IP" });
  await expect(asked).toBeVisible();
  await expect(page.locator(".assistant-message-meta").first()).toContainText(
    "Session Homelab deploy (project homelab) asks",
  );
  const note = page.locator('[data-session-talk="send"]');
  await expect(note).toContainText(
    "Message to session Homelab deploy (project homelab) · accepted",
  );
  await expect(note).toContainText("“10.0.0.42 is reserved for you”");
});

test("⌘K's Agent access opens the dialog of that running session", async ({ page }) => {
  await talkFixture(page);
  await page.goto(baseURL + "/sessions/bare/chat");
  await expect(page.getByRole("button", { name: "Agent access" }).first()).toBeVisible();
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  const mac = await page.evaluate(() => /mac/i.test(navigator.platform));
  await page.keyboard.press(mac ? "Meta+k" : "Control+k");
  const search = page.getByRole("dialog", { name: "Search" });
  await expect(search).toBeVisible();
  await search.getByRole("combobox").fill("agent access deploy");
  await search
    .getByRole("option", { name: /Homelab deploy · Agent access/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/sessions\/deploy(\/|$)/);
  await expect(dialog(page).getByRole("heading", { name: "Agent access" })).toBeVisible();
  await expect(dialog(page).getByText("Can ask agents", { exact: true })).toBeVisible();
});
