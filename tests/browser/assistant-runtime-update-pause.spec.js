import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

// The update page names what blocks an activation, item by item, and "Pause agents
// and update" confirms exactly what happens to each (runtime-update-blockers.js).
const channelInput = {
  id: "channel_input:input-1",
  code: "CHANNEL_WORK",
  kind: "channel_input",
  agent: { id: "agent-1", name: "Network Architect" },
  since: "2026-10-26T09:30:00.000Z",
  link: "/agents/agent-1/settings?tab=channels&page=telegram-activity",
  resolution: "close",
  revision: "rev-input",
};
const chatTurn = {
  id: "chat_turn:attempt-1",
  code: "ASSISTANT_WORK",
  kind: "chat_turn",
  agent: { id: "agent-1", name: "Network Architect" },
  since: "2026-10-30T09:00:00.000Z",
  link: "/agents/agent-1/chats/chat-1",
  resolution: "stop",
  revision: "rev-turn",
};
const login = {
  id: "login:login-1",
  code: "ACCOUNT_LOGIN",
  kind: "login",
  agent: null,
  since: "2026-10-30T08:00:00.000Z",
  link: "/connections?section=models&item=chatgpt",
  resolution: "none",
  revision: "rev-login",
};

async function setup(page, language = "en") {
  await fixture(page);
  await page.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  const state = {
    activations: [],
    preview: [channelInput, chatTurn],
    status: {
      phase: "staged",
      currentVersion: "2026.10.3",
      targetVersion: "2026.10.5",
      candidateReady: true,
      updateAvailable: true,
      affectedAssistants: 2,
      affectedTeamMembers: 0,
      blockers: ["ASSISTANT_WORK", "CHANNEL_WORK"],
      blockerItems: [chatTurn, channelInput],
      diagnostic: "UPDATE_BLOCKED",
      recoveryRequired: false,
      busy: false,
    },
  };
  await page.route("**/api/assistant-feature", fulfillEnabledAssistantFeature);
  await page.route("**/api/assistant-runtime/updates**", async (route) => {
    const request = route.request();
    const action = new URL(request.url()).pathname.split("/").at(-1);
    if (action === "blockers") return route.fulfill({ json: { items: state.preview } });
    if (request.method() === "POST" && action === "activate") {
      state.activations.push(request.postDataJSON());
      Object.assign(state.status, {
        phase: "complete",
        currentVersion: "2026.10.5",
        candidateReady: false,
        blockers: [],
        blockerItems: [],
        diagnostic: null,
      });
    }
    await route.fulfill({ json: state.status });
  });
  return state;
}
const panelOf = (page, title) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: title }) });

test("the update page lists each blocker and pauses agents to update after confirmation", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto(baseURL + "/settings/assistants");
  const panel = panelOf(page, "OpenClaw updates");
  const list = panel.getByRole("group", { name: "Open work" });
  await expect(list.getByText("Telegram input · Network Architect")).toBeVisible();
  await expect(list.getByText("Chat turn · Network Architect")).toBeVisible();
  await expect(
    list.getByRole("link", { name: /Telegram input · Network Architect/ }),
  ).toHaveAttribute("href", channelInput.link);
  await expect(list.getByText(/^Since /).first()).toBeVisible();
  await panel.getByRole("button", { name: "Pause agents and update" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Pause agents and update to 2026.10.5?",
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(/Closed without sending\. Nothing is sent again\./),
  ).toBeVisible();
  await expect(dialog.getByText(/The running turn is stopped\./)).toBeVisible();
  // Destructive: the dialog starts on Cancel.
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Pause and update" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByText("Update complete", { exact: true })).toBeVisible();
  await expect(panel.getByRole("group", { name: "Open work" })).toHaveCount(0);
  // Exactly the items and revisions the dialog showed.
  expect(state.activations).toEqual([
    {
      resolveBlockers: true,
      items: [
        { id: channelInput.id, revision: "rev-input" },
        { id: chatTurn.id, revision: "rev-turn" },
      ],
    },
  ]);
});

test("a sign-in in progress keeps pause and update disabled with a hint", async ({
  page,
}) => {
  const state = await setup(page);
  state.preview = [chatTurn, login];
  await page.goto(baseURL + "/settings/assistants");
  const panel = panelOf(page, "OpenClaw updates");
  await panel.getByRole("button", { name: "Pause agents and update" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Pause agents and update to 2026.10.5?",
  });
  await expect(dialog.getByText("Model account sign-in", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText(/A model account sign-in is in progress\./).first(),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Pause and update" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  // Once the refused activation lists the sign-in, the button itself stays off.
  state.status.blockerItems = [login];
  state.status.blockers = ["ACCOUNT_LOGIN"];
  await page.reload();
  await expect(
    panel.getByRole("button", { name: "Pause agents and update" }),
  ).toBeDisabled();
  await expect(
    panel.getByText(/Finish or cancel it under Connections › Model access/),
  ).toBeVisible();
  expect(state.activations).toEqual([]);
});

test("pause and update speaks German", async ({ page }) => {
  await setup(page, "de");
  await page.goto(baseURL + "/settings/assistants");
  const panel = panelOf(page, "OpenClaw-Updates");
  await expect(
    panel
      .getByRole("group", { name: "Offene Arbeit" })
      .getByText("Telegram-Eingang · Network Architect"),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Agenten anhalten und aktualisieren" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Agenten anhalten und auf 2026.10.5 aktualisieren?",
  });
  await expect(dialog.getByText(/Wird ohne Versand geschlossen\./)).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Anhalten und aktualisieren" }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  await expect(dialog).toHaveCount(0);
});
