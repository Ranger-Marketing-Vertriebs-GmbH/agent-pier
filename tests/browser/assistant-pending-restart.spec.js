import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { accountDetail, openAccountItem } from "../helpers/accounts-browser.js";
import { fixture } from "./providers-fixture.js";

test.use({ locale: "en-GB" });

// Set AGENTPIER_PENDING_RESTART_SHOTS to a directory to keep screenshots of the states.
const shots = process.env.AGENTPIER_PENDING_RESTART_SHOTS;
const shoot = (page, name) =>
  shots ? page.screenshot({ path: `${shots}/202-${name}.png` }) : null;

const connection = {
  id: "agent-router",
  name: "Agent router",
  providerId: "openrouter",
  hasSecret: true,
  launchable: true,
  tools: ["codex", "claude", "opencode"],
  createdAt: "2026-09-07T12:00:00Z",
  updatedAt: "2026-09-07T12:00:00Z",
};

async function setup(page) {
  const controls = await fixture(page);
  controls.state.providerConnections = [connection];
  controls.assistantConnections.add(connection.id);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const state = {
    posts: 0,
    pending: {
      since: Date.parse("2026-10-23T10:00:00Z"),
      reasons: ["connection", "webSearch"],
      affected: { agents: [{ id: "a", name: "Olli" }], teamMembers: 2 },
      waitingFor: ["ASSISTANT_WORK"],
      running: false,
    },
  };
  const view = () => ({
    availability: "ready",
    sync: "ready",
    pendingRestart: state.pending,
  });
  await page.route("**/api/assistant-feature", fulfillEnabledAssistantFeature);
  await page.route("**/api/assistant-runtime", (route) =>
    route.fulfill({ json: view() }),
  );
  await page.route("**/api/assistant-runtime/pending-restart", (route) => {
    state.posts++;
    state.pending = null;
    return route.fulfill({ json: view() });
  });
  return state;
}

test("the agent service shows a pending restart and restarts at once after confirming", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto(baseURL + "/settings/assistants");
  const notice = page.getByRole("group", { name: "Agent service restart pending" });
  await expect(notice).toContainText(
    "It restarts by itself as soon as no agent is busy.",
  );
  await expect(notice).toContainText("Needed for: a provider connection, web search");
  await expect(notice).toContainText("Waiting for: agents at work");
  await shoot(page, "agent-service-pending");
  await notice.getByRole("button", { name: /Restart now/ }).click();
  const dialog = page.getByRole("dialog", { name: "Restart the agent service now?" });
  await expect(dialog).toContainText("Running agent work is interrupted");
  await expect(dialog).toContainText("Briefly unavailable: Olli (+2 team members)");
  await shoot(page, "restart-now-confirm");
  // Cancel first: nothing restarts.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(state.posts).toBe(0);
  await notice.getByRole("button", { name: /Restart now/ }).click();
  await dialog.getByRole("button", { name: "Restart now", exact: true }).click();
  await expect(notice).toHaveCount(0);
  expect(state.posts).toBe(1);
});

test("a connection agents use shows the pending restart beside its settings", async ({
  page,
}) => {
  await setup(page);
  await page.goto(baseURL + "/accounts");
  await openAccountItem(page, "Agent router");
  const dialog = accountDetail(page);
  await expect(
    dialog.getByRole("group", { name: "Agent service restart pending" }),
  ).toContainText("Waiting for: agents at work");
  await shoot(page, "connection-pending");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
