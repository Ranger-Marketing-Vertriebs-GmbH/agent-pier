import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// What the agents say about the connection (AGENTPIER-423): a live channel that fell
// back to REST reads that work is no lost connection, and a page that cannot reach
// AgentPier does not claim that the agent service is ready.
const lostNote = "Connection lost. Showing the last known agents.";

async function fixture(page) {
  await chatFixture(page);
  const network = { offline: false };
  await page.route("**/auth/status", (route) =>
    route.fulfill({ json: { configured: true, authenticated: true, canSetup: false } }),
  );
  await page.route("**/api/**", (route) =>
    network.offline ? route.abort("internetdisconnected") : route.fallback(),
  );
  return network;
}

test("a live channel polling REST that answers shows no lost connection", async ({
  page,
  liveStub,
}) => {
  await fixture(page);
  await page.goto(baseURL + "/agents");
  const main = page.locator("main");
  await expect(main.getByText("Home assistant").first()).toBeVisible();
  // Three refused sockets switch the channel to polling REST (live-client.js).
  liveStub.refuse();
  await page.waitForTimeout(6000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(main.getByText("Home assistant").first()).toBeVisible();
  await expect(page.getByText(lostNote)).toHaveCount(0);
});

test("without AgentPier the agent service status is unknown, not ready", async ({
  page,
  liveStub,
}) => {
  const network = await fixture(page);
  await page.goto(baseURL + "/agents");
  const readiness = page
    .getByRole("region", { name: "Readiness" })
    .or(page.locator(".list-card").filter({ hasText: "Agent service:" }));
  await expect(readiness.getByText("Agent service: Ready")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("agentpier.agent-list.v1")))
    .not.toBeNull();
  network.offline = true;
  liveStub.refuse();
  await page.reload();
  await expect(page.getByText(lostNote).first()).toBeAttached();
  await expect(page.getByText("Agent service: Unknown while offline")).toBeVisible();
  await expect(page.getByText("Agent service: Ready")).toHaveCount(0);
});
